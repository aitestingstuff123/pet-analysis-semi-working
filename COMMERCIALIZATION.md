# Commercialization Guide for PawBehavior

This guide outlines the steps to move from the current development/simulation mode to a live, monetized application.

## 1. Payments (Stripe Integration)

The application is now configured to use **Stripe Checkout** for "Pro" upgrades.

### Steps to Go Live:
1.  **Create a Stripe Account**: Sign up at [stripe.com](https://stripe.com).
2.  **Get API Keys**: Go to the Stripe Dashboard -> Developers -> API Keys.
    -   Copy the **Secret Key**.
    -   Add it to your AI Studio Secrets as `STRIPE_SECRET_KEY`.
3.  **Create a Product**:
    -   Go to Product Catalog -> Add Product.
    -   Name it "PawBehavior Pro".
    -   Set it as a **Recurring** (Subscription) price.
    -   Copy the **Price ID** (starts with `price_...`).
    -   Add it to your AI Studio Secrets as `STRIPE_PRO_PRICE_ID`.
4.  **Set Up Webhooks**:
    -   Go to Developers -> Webhooks -> Add Endpoint.
    -   URL: `https://your-app-url.com/api/stripe-webhook`
    -   Select Event: `checkout.session.completed`.
    -   Copy the **Signing Secret** (starts with `whsec_...`).
    -   Add it to your AI Studio Secrets as `STRIPE_WEBHOOK_SECRET`.

## 2. Advertising (AdSense / AdMob)

The current "Watch Ad" feature is a simulation. To show real ads:

### For Web (Google AdSense):
1.  **Sign up for AdSense**: [google.com/adsense](https://google.com/adsense).
2.  **Add your Site**: Verify your domain.
3.  **Create Ad Units**: Use "Rewarded Ads" if available for your account type, or standard display ads.
4.  **Integration**: Replace the `setTimeout` in `handleWatchAd` with the AdSense Rewarded Ad API call.

### For Mobile (AdMob):
If you wrap this app using **Capacitor** or **Cordova** for iOS/Android:
1.  **Sign up for AdMob**: [google.com/admob](https://google.com/admob).
2.  **Install Capacitor AdMob Plugin**: `npm install @capacitor-community/admob`.
3.  **Configure Ad Unit IDs**: Use the IDs provided in the AdMob dashboard.

## 3. Production Readiness

1.  **Firebase Quotas**: Monitor your Firestore and Storage usage. As you scale, you may need to move to a paid Firebase plan (Blaze).
2.  **Gemini API Limits**: The free tier of Gemini has rate limits. For high traffic, consider the paid tier in Google Cloud Console.
3.  **Domain**: Connect a custom domain (e.g., `pawbehavior.com`) via the AI Studio settings or your hosting provider.
