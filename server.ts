import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import multer from "multer";
import dotenv from "dotenv";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import cors from "cors";
import { initializeApp } from 'firebase/app';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import Stripe from 'stripe';
import admin from 'firebase-admin';
import { getStorage as getStorageAdmin } from 'firebase-admin/storage';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

dotenv.config();

// Initialize Firebase Admin
let dbAdmin: any = null;
let bucket: any = null;
let firebaseConfig: any = null;

try {
  const configPath = path.resolve(process.cwd(), "firebase-applet-config.json");
  if (fs.existsSync(configPath)) {
    firebaseConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
        projectId: firebaseConfig.projectId,
        storageBucket: firebaseConfig.storageBucket
      });
      console.log("[Server] Firebase Admin initialized with Project ID:", firebaseConfig.projectId);
    }

    // Initialize Firestore with the specific database ID from config
    const dbId = firebaseConfig.firestoreDatabaseId || "(default)";
    dbAdmin = getFirestore(dbId);
    
    // Initialize Storage Bucket
    const bucketName = firebaseConfig.storageBucket;
    bucket = getStorageAdmin().bucket(bucketName);
    
    console.log(`[Server] Firestore Admin (DB: ${dbId}) and Storage Bucket (${bucketName}) initialized`);
  } else {
    console.warn("[Server] firebase-applet-config.json not found");
  }
} catch (err) {
  console.error("[Server] Firebase Admin initialization error:", err);
}

// Initialize Firebase Client SDK (for frontend config if needed, but mostly for storage fallback if any)
let storage: any;
try {
  if (firebaseConfig) {
    const firebaseApp = initializeApp(firebaseConfig);
    storage = getStorage(firebaseApp);
    console.log("[Server] Firebase Client Storage initialized");
  }
} catch (err) {
  console.error("[Server] Firebase Client initialization error:", err);
}

// Stripe initialization
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

if (ffmpegPath) {
  console.log("[Server] Setting FFmpeg path to:", ffmpegPath);
  ffmpeg.setFfmpegPath(ffmpegPath);
} else {
  console.warn("[Server] ffmpeg-static path not found");
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const upload = multer({ 
  dest: "uploads/",
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB
  }
});

interface MulterRequest extends express.Request {
  file?: any;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // API Request Logging
  app.use("/api", (req, res, next) => {
    console.log(`[Server] API Request: ${req.method} ${req.url}`);
    next();
  });

  // Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Stripe Checkout Session
  app.post("/api/create-checkout-session", async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ 
        error: "Stripe is not configured on the server.",
        details: "Please add STRIPE_SECRET_KEY and STRIPE_PRO_PRICE_ID to the Secrets panel in AI Studio Settings."
      });
    }

    const { userId, email, stripeCustomerId } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    try {
      const session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId || undefined,
        customer_creation: stripeCustomerId ? undefined : 'always',
        payment_method_types: ["card"],
        line_items: [
          {
            price: process.env.STRIPE_PRO_PRICE_ID,
            quantity: 1,
          },
        ],
        mode: "subscription",
        success_url: `${process.env.APP_URL || 'http://localhost:3000'}/?session_id={CHECKOUT_SESSION_ID}&upgrade=success`,
        cancel_url: `${process.env.APP_URL || 'http://localhost:3000'}/?upgrade=cancel`,
        customer_email: stripeCustomerId ? undefined : email,
        client_reference_id: userId,
        metadata: {
          userId: userId,
        },
      });

      res.json({ id: session.id, url: session.url });
    } catch (error: any) {
      console.error("[Stripe] Checkout error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Stripe Customer Sync
  app.post("/api/sync-customer", async (req, res) => {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured." });
    }

    const { userId, email, name } = req.body;
    if (!userId || !email) {
      return res.status(400).json({ error: "User ID and Email are required" });
    }

    try {
      // Check if customer already exists in Stripe by email
      const customers = await stripe.customers.list({ email, limit: 1 });
      let customer;

      if (customers.data.length > 0) {
        customer = customers.data[0];
      } else {
        // Create new customer
        customer = await stripe.customers.create({
          email,
          name,
          metadata: { userId },
        });
      }

      // Update Firestore with Stripe Customer ID
      if (dbAdmin) {
        await dbAdmin.collection("users").doc(userId).set({
          stripeCustomerId: customer.id,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      res.json({ stripeCustomerId: customer.id });
    } catch (error: any) {
      console.error("[Stripe Sync] Error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Stripe Webhook
  app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(500).json({ error: "Stripe Webhook is not configured." });
    }

    const sig = req.headers["stripe-signature"] as string;
    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err: any) {
      console.error(`[Stripe Webhook] Error: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency check
    if (dbAdmin) {
      const eventRef = dbAdmin.collection("processed_events").doc(event.id);
      const eventDoc = await eventRef.get();
      if (eventDoc.exists) {
        console.log(`[Stripe Webhook] Event ${event.id} already processed.`);
        return res.json({ received: true, alreadyProcessed: true });
      }
      await eventRef.set({
        type: event.type,
        processedAt: FieldValue.serverTimestamp(),
      });
    }

    // Handle the event
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id || session.metadata?.userId;
      const customerId = session.customer as string;
      const subscriptionId = session.subscription as string;

      if (userId && dbAdmin) {
        console.log(`[Stripe Webhook] Upgrading user ${userId} to Pro`);
        try {
          // Get subscription details to find period end
          const subscription = await stripe.subscriptions.retrieve(subscriptionId) as any;
          const premiumUntil = Timestamp.fromMillis(subscription.current_period_end * 1000);

          await dbAdmin.collection("users").doc(userId).set({
            stripeId: customerId,
            subscriptionId: subscriptionId,
            status: "pro",
            subscriptionTier: "pro", // Keep legacy field if needed
            premiumUntil: premiumUntil,
            upgradedAt: FieldValue.serverTimestamp(),
          }, { merge: true });
        } catch (dbErr) {
          console.error("[Stripe Webhook] Database update error:", dbErr);
        }
      }
    }

    res.json({ received: true });
  });

  // Ensure uploads directory exists
  if (!fs.existsSync("uploads")) {
    fs.mkdirSync("uploads");
  }

  // API Routes
  app.post("/api/process", (req, res, next) => {
    console.log("[Server] Entering /api/process route");
    upload.single("media")(req, res, (err) => {
      if (err) {
        console.error("[Server] Multer Error:", err);
        return res.status(400).json({ 
          error: err instanceof multer.MulterError ? `File upload error: ${err.message}` : "Failed to upload file" 
        });
      }
      console.log("[Server] Multer upload successful, proceeding to handler");
      next();
    });
  }, async (req: MulterRequest, res) => {
    console.log(`[Server] Processing upload: ${req.file?.originalname}`);
    
    let tempPath = req.file?.path;
    let compressedPath = "";

    try {
      if (!storage) {
        throw new Error("Firebase Storage not initialized. Check server logs.");
      }

      if (!req.file) {
        console.error("[Server] No file received in request");
        return res.status(400).json({ error: "No media file uploaded" });
      }

      const userId = req.body.userId;
      if (!userId) {
        return res.status(400).json({ error: "User ID is required for processing" });
      }

      // Fetch user usage from Firestore
      let monthlyAnalysesCount = 0;
      let isPro = false;
      const now = new Date();
      const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

      if (dbAdmin) {
        try {
          console.log(`[Server] Fetching user doc for ${userId} from database: ${firebaseConfig.firestoreDatabaseId || '(default)'}`);
          const userDoc = await dbAdmin.collection("users").doc(userId).get();
          if (userDoc.exists) {
            const userData = userDoc.data();
            isPro = userData?.subscriptionTier === 'pro';
            const monthlyUsage = userData?.monthlyUsage || {};
            monthlyAnalysesCount = monthlyUsage[monthKey] || 0;
            console.log(`[Server] User ${userId} isPro: ${isPro}, usage: ${monthlyAnalysesCount}`);
          } else {
            console.log(`[Server] User doc for ${userId} not found`);
          }
        } catch (dbErr: any) {
          console.error("[Server] Firestore usage fetch failed:", dbErr);
          // If this fails with PERMISSION_DENIED, it's a database access issue
          if (dbErr.message.includes("PERMISSION_DENIED")) {
            console.warn("[Server] Firestore Permission Denied. Falling back to default usage (0).");
            // We continue with 0 to allow the analysis to proceed if it's just a tracking issue
          } else {
            throw dbErr;
          }
        }
      }

      // 3. Subscription Hard-Cap (300 analyses/month)
      if (monthlyAnalysesCount >= 300) {
        return res.status(429).json({ 
          error: "Monthly limit reached", 
          code: "SOFT_PAUSE",
          message: "You have exceeded 300 analyses this month. Please verify you are not a bot to continue." 
        });
      }

      // 1. Smart Routing Logic
      // First 30: Pro, Subsequent: Flash
      const modelToUse = monthlyAnalysesCount < 30 ? "gemini-3.1-pro-preview" : "gemini-3-flash-preview";
      const isHeavyUser = monthlyAnalysesCount >= 30;

      // Strict type enforcement for security
      const isVideo = req.file.mimetype.startsWith("video/");
      const isAudio = req.file.mimetype.startsWith("audio/");
      
      if (!isVideo && !isAudio) {
        console.warn(`[Server] Rejected invalid file type: ${req.file.mimetype}`);
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return res.status(400).json({ error: "Invalid file type. Only video and audio are allowed." });
      }

      // 2. Token Shaving (FFmpeg)
      // Aggressively downsample for 'Heavy Users'
      if (isVideo) {
        console.log(`[Server] Starting video compression (Heavy User: ${isHeavyUser})...`);
        compressedPath = `uploads/compressed_${req.file.filename}.mp4`;
        
        const ffmpegOptions = [
          "-vcodec libx264",
          "-crf 32",
          "-preset faster",
          "-acodec aac",
          "-ac 1",
          "-b:a 64k",
          "-t 60"
        ];

        if (isHeavyUser) {
          // Aggressive downsampling: 480p, 10 FPS
          ffmpegOptions.push("-vf scale='min(640,iw)':-2,fps=10");
        } else {
          // Standard: 480p, 15 FPS
          ffmpegOptions.push("-vf scale='min(854,iw)':-2,fps=15");
        }

        await new Promise((resolve, reject) => {
          ffmpeg(tempPath)
            .outputOptions(ffmpegOptions)
            .save(compressedPath)
            .on("end", resolve)
            .on("error", (err) => {
              console.error("[Server] FFmpeg Error:", err);
              reject(err);
            });
        });
        console.log("[Server] Compression complete");
      }

      if (!fs.existsSync(compressedPath || tempPath)) {
        throw new Error("Media file disappeared after processing");
      }

      // 4. Upload to Firebase Storage using Admin SDK (bypasses rules)
      let mediaUrl = "";
      const fileName = `analyses/${userId}/${Date.now()}_${req.file.originalname}`;
      const mimeType = compressedPath ? "video/mp4" : req.file.mimetype;
      
      try {
        if (bucket) {
          console.log(`[Server] Saving to bucket: ${fileName}...`);
          const file = bucket.file(fileName);
          await file.save(fs.readFileSync(compressedPath || tempPath), {
            metadata: { contentType: mimeType }
          });
          // Construct public URL - if public:true fails, we can use a signed URL or a standard Firebase Storage URL
          mediaUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(fileName)}?alt=media`;
          console.log("[Server] Uploaded to Storage via Admin SDK:", mediaUrl);
        } else {
          throw new Error("Storage bucket not initialized");
        }
      } catch (uploadErr: any) {
        console.error("[Server] Admin Storage upload failed:", uploadErr);
        if (uploadErr.message.includes("PERMISSION_DENIED")) {
          console.warn("[Server] Storage Permission Denied. Proceeding without remote URL.");
          mediaUrl = ""; // Frontend will handle missing URL
        } else if (storage) {
          console.log("[Server] Trying Client SDK fallback...");
          try {
            const storageRef = ref(storage, fileName);
            const snapshot = await uploadBytes(storageRef, fs.readFileSync(compressedPath || tempPath), {
              contentType: mimeType
            });
            mediaUrl = await getDownloadURL(snapshot.ref);
          } catch (clientErr) {
            console.error("[Server] Client SDK fallback also failed:", clientErr);
            mediaUrl = "";
          }
        } else {
          mediaUrl = "";
        }
      }

      // Return processed media, URL, and routing info to frontend
      const finalBuffer = fs.readFileSync(compressedPath || tempPath);
      res.json({
        base64: finalBuffer.toString("base64"),
        mimeType: mimeType,
        mediaUrl: mediaUrl,
        modelToUse: modelToUse,
        isHeavyUser: isHeavyUser,
        usageStats: {
          monthlyCount: monthlyAnalysesCount,
          monthKey: monthKey
        }
      });
    } catch (error: any) {
      console.error("[Server] Processing error:", error);
      res.status(500).json({ 
        error: "Media processing failed", 
        details: error.message 
      });
    } finally {
      // Cleanup temp files
      try {
        if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        if (compressedPath && fs.existsSync(compressedPath)) fs.unlinkSync(compressedPath);
      } catch (cleanupError) {
        console.error("[Server] Cleanup error:", cleanupError);
      }
    }
  });

  // Catch-all for API routes to prevent falling through to SPA middleware
  app.all("/api/*", (req, res) => {
    console.warn(`[Server] API 404: ${req.method} ${req.url}`);
    res.status(404).json({ error: `API endpoint ${req.method} ${req.url} not found` });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // Global Error Handler to ensure JSON responses
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    console.error("[Server] Global Error:", err);
    res.status(500).json({ 
      error: "Internal Server Error", 
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  });

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
