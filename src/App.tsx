import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Upload, 
  Dog, 
  Cat, 
  Activity, 
  History, 
  LogOut, 
  ChevronRight, 
  AlertCircle, 
  CheckCircle2, 
  Loader2,
  Play,
  FileText,
  User as UserIcon
} from 'lucide-react';
import { GoogleGenAI } from '@google/genai';
import { useAuth } from './lib/AuthContext';
import { signInWithGoogle, logout, db, collection, query, where, orderBy, onSnapshot, Timestamp } from './lib/firebase';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export default function App() {
  const { user, loading, isAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState<'dashboard' | 'upload' | 'history'>('dashboard');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [analyses, setAnalyses] = useState<any[]>([]);
  const [selectedAnalysis, setSelectedAnalysis] = useState<any>(null);

  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'analyses'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const docs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setAnalyses(docs);
    });

    return () => unsubscribe();
  }, [user]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user) return;

    setIsUploading(true);
    setUploadProgress(10);

    const formData = new FormData();
    formData.append('media', file);

    try {
      // Step 1: Compress on backend
      setUploadProgress(30);
      
      const compressResponse = await fetch('/api/compress', {
        method: 'POST',
        body: formData,
      });

      if (!compressResponse.ok) throw new Error("Compression failed");
      
      const { base64, mimeType } = await compressResponse.json();
      setUploadProgress(60);

      // Step 2: Analyze with Gemini on frontend
      const prompt = `Analyze this pet behavior video/audio. 
      Provide a detailed report including:
      1. Observations (list of objects with 'event' and 'meaning' keys)
      2. Emotional state (string)
      3. Recommended action steps (list of strings)
      Format the response as a clean JSON object.`;

      const geminiResult = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: {
          parts: [
            {
              inlineData: {
                data: base64,
                mimeType: mimeType,
              },
            },
            { text: prompt }
          ]
        }
      });

      const text = geminiResult.text || "";
      let result;
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        result = jsonMatch ? JSON.parse(jsonMatch[0]) : { raw: text };
      } catch (e) {
        result = { raw: text };
      }

      setUploadProgress(90);

      // Step 3: Save to Firestore directly
      const { addDoc, collection, Timestamp } = await import('./lib/firebase');
      await addDoc(collection(db, 'analyses'), {
        userId: user.uid,
        petName: 'My Pet',
        mediaType: file.type.startsWith('video') ? 'video' : 'audio',
        status: 'completed',
        result,
        createdAt: Timestamp.now()
      });

      setUploadProgress(100);
      setTimeout(() => {
        setIsUploading(false);
        setActiveTab('dashboard');
      }, 500);
    } catch (error) {
      console.error("Upload failed:", error);
      setIsUploading(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-purple-50 flex flex-col items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full text-center space-y-8"
        >
          <div className="flex justify-center">
            <div className="w-20 h-20 bg-indigo-600 rounded-3xl flex items-center justify-center shadow-xl shadow-indigo-200">
              <Dog className="w-12 h-12 text-white" />
            </div>
          </div>
          
          <div className="space-y-2">
            <h1 className="text-4xl font-bold tracking-tight text-slate-900">PawBehavior</h1>
            <p className="text-slate-500 text-lg">Professional AI behavior analysis for your beloved pets.</p>
          </div>

          <button
            onClick={signInWithGoogle}
            className="w-full flex items-center justify-center gap-3 bg-white border border-slate-200 text-slate-700 px-6 py-4 rounded-2xl font-medium hover:bg-slate-50 transition-all shadow-sm hover:shadow-md active:scale-[0.98]"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/layout/google.svg" className="w-5 h-5" alt="Google" />
            Sign in with Google
          </button>
          
          <p className="text-xs text-slate-400">
            By signing in, you agree to our Terms of Service and Privacy Policy.
          </p>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-slate-200 flex flex-col">
        <div className="p-6 flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
            <Dog className="w-6 h-6 text-white" />
          </div>
          <span className="font-bold text-xl text-slate-900">PawBehavior</span>
        </div>

        <nav className="flex-1 px-4 space-y-2">
          <NavItem 
            active={activeTab === 'dashboard'} 
            onClick={() => { setActiveTab('dashboard'); setSelectedAnalysis(null); }}
            icon={<Activity className="w-5 h-5" />}
            label="Dashboard"
          />
          <NavItem 
            active={activeTab === 'upload'} 
            onClick={() => { setActiveTab('upload'); setSelectedAnalysis(null); }}
            icon={<Upload className="w-5 h-5" />}
            label="New Analysis"
          />
          <NavItem 
            active={activeTab === 'history'} 
            onClick={() => { setActiveTab('history'); setSelectedAnalysis(null); }}
            icon={<History className="w-5 h-5" />}
            label="History"
          />
        </nav>

        <div className="p-4 border-t border-slate-100">
          <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 mb-4">
            <img src={user.photoURL || ''} className="w-10 h-10 rounded-full border-2 border-white shadow-sm" alt="" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-slate-900 truncate">{user.displayName}</p>
              <p className="text-xs text-slate-500 truncate">{user.email}</p>
            </div>
          </div>
          <button 
            onClick={logout}
            className="w-full flex items-center gap-2 text-slate-500 hover:text-red-600 hover:bg-red-50 p-2 rounded-lg transition-colors text-sm font-medium"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto p-8">
        <header className="mb-8 flex justify-between items-end">
          <div>
            <h2 className="text-3xl font-bold text-slate-900">
              {selectedAnalysis ? 'Analysis Report' : activeTab === 'dashboard' ? 'Dashboard' : activeTab === 'upload' ? 'New Analysis' : 'Report History'}
            </h2>
            <p className="text-slate-500 mt-1">
              {selectedAnalysis ? `Report for ${selectedAnalysis.petName || 'My Pet'}` : `Welcome back, ${user.displayName?.split(' ')[0]}`}
            </p>
          </div>
          {activeTab === 'dashboard' && !selectedAnalysis && (
            <button 
              onClick={() => setActiveTab('upload')}
              className="bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-medium hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 flex items-center gap-2"
            >
              <Upload className="w-4 h-4" />
              New Analysis
            </button>
          )}
          {selectedAnalysis && (
            <button 
              onClick={() => setSelectedAnalysis(null)}
              className="text-slate-500 hover:text-slate-900 font-medium flex items-center gap-2"
            >
              Back to {activeTab}
            </button>
          )}
        </header>

        <AnimatePresence mode="wait">
          {selectedAnalysis ? (
            <motion.div
              key="analysis-detail"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                <div className="md:col-span-2 space-y-6">
                  {/* Observations */}
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <Activity className="w-5 h-5 text-indigo-600" />
                      Observations
                    </h3>
                    <div className="space-y-4">
                      {selectedAnalysis.result?.observations?.map((obs: any, i: number) => (
                        <div key={i} className="p-4 bg-slate-50 rounded-xl border border-slate-100">
                          <p className="font-bold text-indigo-600 text-sm uppercase tracking-wider">{obs.event}</p>
                          <p className="text-slate-700 mt-1">{obs.meaning}</p>
                        </div>
                      )) || <p className="text-slate-500 italic">No detailed observations recorded.</p>}
                    </div>
                  </div>

                  {/* Action Steps */}
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
                      <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                      Recommended Action Steps
                    </h3>
                    <ul className="space-y-3">
                      {selectedAnalysis.result?.actionSteps?.map((step: string, i: number) => (
                        <li key={i} className="flex items-start gap-3">
                          <div className="w-6 h-6 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-bold mt-0.5">
                            {i + 1}
                          </div>
                          <span className="text-slate-700">{step}</span>
                        </li>
                      )) || <p className="text-slate-500 italic">No specific action steps provided.</p>}
                    </ul>
                  </div>
                </div>

                <div className="space-y-6">
                  {/* Emotional State */}
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
                    <h3 className="text-sm font-bold text-slate-500 uppercase tracking-wider mb-2">Emotional State</h3>
                    <p className="text-2xl font-bold text-indigo-600">
                      {selectedAnalysis.result?.emotionalState || 'Unknown'}
                    </p>
                  </div>

                  {/* Metadata */}
                  <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm space-y-4">
                    <div>
                      <h4 className="text-xs font-bold text-slate-400 uppercase">Analysis Date</h4>
                      <p className="text-slate-700 font-medium">
                        {new Date(selectedAnalysis.createdAt?.seconds * 1000).toLocaleString()}
                      </p>
                    </div>
                    <div>
                      <h4 className="text-xs font-bold text-slate-400 uppercase">Media Type</h4>
                      <p className="text-slate-700 font-medium capitalize">{selectedAnalysis.mediaType}</p>
                    </div>
                  </div>
                </div>
              </div>
            </motion.div>
          ) : activeTab === 'dashboard' ? (
            <motion.div 
              key="dashboard"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="grid grid-cols-1 md:grid-cols-3 gap-6"
            >
              <StatCard label="Total Analyses" value={analyses.length} icon={<Activity className="text-indigo-600" />} />
              <StatCard label="Completed" value={analyses.filter(a => a.status === 'completed').length} icon={<CheckCircle2 className="text-emerald-600" />} />
              <StatCard label="Pending" value={analyses.filter(a => a.status === 'pending').length} icon={<Loader2 className="text-amber-600" />} />

              <div className="md:col-span-3 bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
                <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                  <h3 className="font-bold text-slate-900">Recent Analyses</h3>
                  <button onClick={() => setActiveTab('history')} className="text-indigo-600 text-sm font-medium hover:underline">View All</button>
                </div>
                <div className="divide-y divide-slate-50">
                  {analyses.slice(0, 5).map((analysis) => (
                    <div 
                      key={analysis.id} 
                      onClick={() => setSelectedAnalysis(analysis)}
                      className="p-4 hover:bg-slate-50 transition-colors flex items-center justify-between cursor-pointer"
                    >
                      <div className="flex items-center gap-4">
                        <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center">
                          {analysis.mediaType === 'video' ? <Play className="w-6 h-6 text-slate-400" /> : <Activity className="w-6 h-6 text-slate-400" />}
                        </div>
                        <div>
                          <p className="font-semibold text-slate-900">{analysis.petName || 'My Pet'}</p>
                          <p className="text-xs text-slate-500">
                            {analysis.createdAt?.seconds ? new Date(analysis.createdAt.seconds * 1000).toLocaleDateString() : 'Just now'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                          analysis.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                        }`}>
                          {analysis.status}
                        </span>
                        <ChevronRight className="w-5 h-5 text-slate-300" />
                      </div>
                    </div>
                  ))}
                  {analyses.length === 0 && (
                    <div className="p-12 text-center">
                      <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                        <FileText className="w-8 h-8 text-slate-300" />
                      </div>
                      <p className="text-slate-500">No analyses yet. Start by uploading a video!</p>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          ) : activeTab === 'history' ? (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm"
            >
              <div className="divide-y divide-slate-50">
                {analyses.map((analysis) => (
                  <div 
                    key={analysis.id} 
                    onClick={() => setSelectedAnalysis(analysis)}
                    className="p-4 hover:bg-slate-50 transition-colors flex items-center justify-between cursor-pointer"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-12 h-12 bg-slate-100 rounded-xl flex items-center justify-center">
                        {analysis.mediaType === 'video' ? <Play className="w-6 h-6 text-slate-400" /> : <Activity className="w-6 h-6 text-slate-400" />}
                      </div>
                      <div>
                        <p className="font-semibold text-slate-900">{analysis.petName || 'My Pet'}</p>
                        <p className="text-xs text-slate-500">
                          {analysis.createdAt?.seconds ? new Date(analysis.createdAt.seconds * 1000).toLocaleString() : 'Just now'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                        analysis.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
                      }`}>
                        {analysis.status}
                      </span>
                      <ChevronRight className="w-5 h-5 text-slate-300" />
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>
          ) : (
            <motion.div 
              key="upload"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="max-w-2xl mx-auto"
            >
              <div className="bg-white rounded-3xl border-2 border-dashed border-slate-200 p-12 text-center">
                {isUploading ? (
                  <div className="space-y-6">
                    <div className="relative w-24 h-24 mx-auto">
                      <svg className="w-full h-full" viewBox="0 0 100 100">
                        <circle className="text-slate-100 stroke-current" strokeWidth="8" cx="50" cy="50" r="40" fill="transparent" />
                        <circle 
                          className="text-indigo-600 stroke-current transition-all duration-500" 
                          strokeWidth="8" 
                          strokeDasharray={251.2}
                          strokeDashoffset={251.2 - (251.2 * uploadProgress) / 100}
                          strokeLinecap="round" 
                          cx="50" cy="50" r="40" fill="transparent" 
                        />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center font-bold text-indigo-600">
                        {uploadProgress}%
                      </div>
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-xl font-bold text-slate-900">Analyzing Behavior...</h3>
                      <p className="text-slate-500">Our AI behaviorist is reviewing your pet's footage.</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-6">
                    <div className="w-20 h-20 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto">
                      <Upload className="w-10 h-10 text-indigo-600" />
                    </div>
                    <div className="space-y-2">
                      <h3 className="text-xl font-bold text-slate-900">Upload Pet Media</h3>
                      <p className="text-slate-500">Select a video or audio clip of your pet's behavior for analysis.</p>
                    </div>
                    <label className="inline-block">
                      <input type="file" className="hidden" accept="video/*,audio/*" onChange={handleUpload} />
                      <span className="bg-indigo-600 text-white px-8 py-3 rounded-xl font-medium hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-100 cursor-pointer">
                        Choose File
                      </span>
                    </label>
                    <p className="text-xs text-slate-400">Supported formats: MP4, MOV, MP3, WAV (Max 50MB)</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function NavItem({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all font-medium ${
        active ? 'bg-indigo-50 text-indigo-600' : 'text-slate-500 hover:bg-slate-50 hover:text-slate-900'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function StatCard({ label, value, icon }: { label: string, value: number | string, icon: React.ReactNode }) {
  return (
    <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
      <div className="flex justify-between items-start mb-4">
        <div className="p-2 bg-slate-50 rounded-lg">{icon}</div>
      </div>
      <p className="text-slate-500 text-sm font-medium">{label}</p>
      <p className="text-2xl font-bold text-slate-900 mt-1">{value}</p>
    </div>
  );
}
