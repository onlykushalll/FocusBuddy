import React, { Component, useState, useEffect, useRef, useCallback } from 'react';
import { 
  Shield, 
  User, 
  ArrowLeft, 
  Plus, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  Play, 
  Pause, 
  Square, 
  Lock,
  Camera,
  UserCheck,
  Smartphone,
  Check,
  ArrowRight,
  AlertCircle,
  UserX,
  ShieldCheck,
  Settings,
  HelpCircle,
  Moon,
  Sun,
  History,
  Info,
  Share2,
  Copy
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  doc, 
  setDoc, 
  onSnapshot, 
  updateDoc, 
  collection, 
  deleteDoc,
  serverTimestamp,
  getDoc,
  getDocFromServer,
  query,
  where,
  orderBy,
  limit,
  getDocs
} from 'firebase/firestore';
import { 
  signInAnonymously, 
  onAuthStateChanged, 
  User as FirebaseUser 
} from 'firebase/auth';
import { db, auth } from './firebase';
import FaceSecurityEngine, { FaceSecurityEngineRef } from './components/FaceSecurityEngine';
import { cn } from './lib/utils';
import SplashScreenPreview from './components/SplashScreenPreview';
import Onboarding from './components/Onboarding';

// --- Android Bridge Type Declaration ---
declare global {
  interface Window {
    Android?: {
      openAccessibilitySettings: () => void;
      isAccessibilityEnabled: () => boolean;
      shareSessionCode: (code: string) => void;
      copyToClipboard: (text: string) => void;
      setSessionToken: (token: string) => void;
      generateSessionToken: () => string;
      startFocusSession: (whitelistJson: string, sessionId: string, buddyId: string, sessionToken: string) => void;
      stopFocusSession: (sessionToken: string) => void;
      updateWhitelist: (whitelistJson: string, sessionToken: string) => void;
      getSessionToken: () => string;
      getInstalledApps: () => string; // Returns JSON string of AppInfo[]
      getAppIcon: (packageName: string) => string; // Returns Base64 string
      launchApp: (packageName: string, sessionToken: string) => void;
      isScreenOn: () => boolean;
    };
  }
}

const getSessionToken = (): string => {
  let token = localStorage.getItem('session_token') || '';
  if (!token && window.Android?.getSessionToken) {
    token = window.Android.getSessionToken();
    if (token) localStorage.setItem('session_token', token);
  }
  return token;
};

// --- Error Handling ---

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends (Component as any) {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): any {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if ((this as any).state.hasError) {
      return (
        <div className="min-h-screen bg-[#FDFBF0] flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mb-6 text-red-500">
            <AlertCircle className="w-10 h-10" />
          </div>
          <h2 className="text-2xl font-black mb-4">Something went wrong</h2>
          <p className="text-neutral-600 mb-8 text-sm leading-relaxed max-w-xs">
            The app encountered an unexpected error. This might be due to a connection issue or a temporary glitch.
          </p>
          <button 
            onClick={() => window.location.reload()}
            className="bg-[#707A3E] text-white px-8 py-3 rounded-xl font-bold shadow-lg"
          >
            Reload App
          </button>
          <div className="mt-8 p-4 bg-neutral-100 dark:bg-neutral-900 rounded-lg text-[10px] text-left overflow-auto max-w-full border border-neutral-200 dark:border-neutral-800">
            <p className="font-bold mb-2 text-red-500 uppercase tracking-widest">Debug Info:</p>
            <pre className="whitespace-pre-wrap break-all text-neutral-500">
              {(this as any).state.error?.toString()}
              {"\n"}
              {(this as any).state.error?.stack}
            </pre>
          </div>
        </div>
      );
    }

    return (this as any).props.children;
  }
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  return errInfo;
}

// --- Types ---

type Role = 'ADMIN' | 'BUDDY' | null;
type SessionStatus = 'lobby' | 'countdown' | 'active' | 'paused' | 'ended';
type BuddyStatus = 'pending' | 'approved' | 'rejected';

interface Session {
  id: string;
  focusActive: boolean;
  adminDeviceId: string;
  timestamp: any;
  timerSeconds: number;
  status: SessionStatus;
  startTime?: any;
  endedAt?: any;
  countdownValue?: number | null;
  buddyIds?: string[];
}

interface AppInfo {
  label: string;
  packageName: string;
  icon: string;
}

interface Buddy {
  id: string;
  name: string;
  deviceId: string;
  faceImage?: string;
  faceDescriptor?: string;
  faceImages?: Record<string, string>;
  status: BuddyStatus;
  installedApps: AppInfo[];
  whitelistedApps: string[];
  lastFaceMatch: boolean;
  pausedByFace?: boolean;
  requestStop: boolean;
  requestPause: boolean;
  isOnline: boolean;
  securityAlert?: string | null;
}

// --- Components ---

function FaceRegistration({ onComplete, onCancel }: { onComplete: (descriptor: string, faceSnapshot: string) => void, onCancel: () => void }) {
  const engineRef = useRef<FaceSecurityEngineRef>(null);

  return (
    <div className="fixed inset-0 z-[200] bg-white dark:bg-black flex flex-col items-center justify-center p-6 backdrop-blur-md">
      <div className="relative w-full max-w-sm aspect-[4/3] rounded-[2.5rem] overflow-hidden border-4 border-[#707A3E]/30 shadow-2xl shadow-[#707A3E]/20 bg-black">
        <FaceSecurityEngine 
          ref={engineRef}
          isSessionActive={false}
          onRegistrationComplete={onComplete}
          onEngineError={(err) => alert(err)}
        />
      </div>

      <div className="mt-8 text-center space-y-4 max-w-sm">
        <h3 className="text-xl font-black tracking-tight">Biometric Registration</h3>
        <p className="text-sm text-neutral-500 font-medium leading-relaxed">
          Look directly at the camera. The verification engine is creating a secure identity profile. This data never leaves your device.
        </p>
        
        <div className="pt-4 flex flex-col gap-2 w-full">
          <motion.button 
            whileTap={{ scale: 0.95 }}
            onClick={() => engineRef.current?.startRegistration()}
            className="w-full bg-[#707A3E] text-white py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] shadow-lg shadow-[#707A3E]/20"
          >
            Start Scan
          </motion.button>
          
          <button 
            onClick={onCancel}
            className="w-full py-4 text-neutral-400 font-bold text-[10px] uppercase tracking-widest"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

const MOCK_APPS: AppInfo[] = [
  { label: "Instagram", packageName: "com.instagram.android", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "TikTok", packageName: "com.zhiliaoapp.musically", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "YouTube", packageName: "com.google.android.youtube", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "WhatsApp", packageName: "com.whatsapp", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Discord", packageName: "com.discord", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Calculator", packageName: "com.android.calculator2", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Notes", packageName: "com.android.notes", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Dictionary", packageName: "com.android.dictionary", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Camera", packageName: "com.android.camera", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Settings", packageName: "com.android.settings", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Chrome", packageName: "com.android.chrome", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Spotify", packageName: "com.spotify.music", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Netflix", packageName: "com.netflix.mediaclient", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Gmail", packageName: "com.google.android.gm", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" },
  { label: "Maps", packageName: "com.google.android.apps.maps", icon: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }
];

export default function App() {
  const [showSplash, setShowSplash] = useState(true);
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(() => {
    return localStorage.getItem('hasSeenOnboarding') === 'true';
  });
  const [view, setView] = useState<'main' | 'settings' | 'about'>('main');
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem('darkMode') === 'true';
  });
  const [role, setRole] = useState<Role>(null);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);

  useEffect(() => {
    const handleOnline = () => setIsOffline(false);
    const handleOffline = () => setIsOffline(true);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Persistence check on mount - commented out to always show the role selection screen on startup
  // useEffect(() => {
  //   const savedRole = localStorage.getItem('active_role') as Role;
  //   if (savedRole) {
  //     setRole(savedRole);
  //   }
  // }, []);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      if (u) {
        setUser(u);
        setError(null);
        setLoading(false);
      } else {
        signInAnonymously(auth).catch(err => {
          if (err.code === 'auth/admin-restricted-operation') {
            setError("Anonymous Authentication is disabled. Please enable it in the Firebase Console (Authentication > Sign-in method).");
          } else {
            setError(`Authentication failed: ${err.message}`);
          }
          console.error('Auth Error:', err);
          setLoading(false);
        });
      }
    });
    return unsub;
  }, []);

  // Test connection
  useEffect(() => {
    if (!user) return; // Wait for auth
    
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
        console.log("Firestore connection verified");
        setError(null);
      } catch (error) {
        console.error("Connection test failed:", error);
        if (error instanceof Error) {
          if (error.message.includes('the client is offline') || error.message.includes('unavailable')) {
            setError("Firestore is unavailable. Please ensure Firestore is enabled in your Firebase console and that you have created a database.");
          } else if (error.message.includes('permission-denied')) {
            setError("Permission denied. Please check your Firestore security rules.");
          } else {
            setError(`Firestore Connection Error: ${error.message}`);
          }
        }
      }
    }
    testConnection();
  }, []);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('darkMode', darkMode.toString());
  }, [darkMode]);

  const toggleDarkMode = () => setDarkMode(!darkMode);

  const handleSplashComplete = useCallback(() => {
    setShowSplash(false);
  }, []);

  const completeOnboarding = () => {
    setHasSeenOnboarding(true);
    localStorage.setItem('hasSeenOnboarding', 'true');
  };

  if (showSplash) {
    return (
      <AnimatePresence>
        <SplashScreenPreview onComplete={handleSplashComplete} />
      </AnimatePresence>
    );
  }

  if (!hasSeenOnboarding) {
    return <Onboarding onComplete={completeOnboarding} />;
  }

  if (view === 'about') {
    return <AboutView onBack={() => setView('main')} />;
  }
  return (
    <ErrorBoundary>
      <div className="h-screen h-[100dvh] overflow-hidden bg-[#FDFBF0] dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 font-sans transition-colors duration-500 selection:bg-[#707A3E]/30 relative">
      {/* Background subtle texture */}
      <div className="absolute inset-0 opacity-[0.02] pointer-events-none dark:opacity-[0.05]" style={{ backgroundImage: `radial-gradient(#707A3E 1px, transparent 1px)`, backgroundSize: '32px 32px' }} />
      
      <div className="relative max-w-md mx-auto px-6 py-6 h-full flex flex-col">
        <header className="flex items-center justify-between mb-8 flex-shrink-0">
          <motion.div 
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            className="flex items-center gap-3"
          >
            <div className="w-10 h-10 bg-gradient-to-br from-[#707A3E] to-[#555D2F] rounded-xl flex items-center justify-center shadow-lg shadow-[#707A3E]/30 flex-shrink-0">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-black tracking-tighter text-[#707A3E] dark:text-[#E1E8C1] truncate">
              Focus Buddy
            </h1>
          </motion.div>
          <div className="flex gap-2 flex-shrink-0">
            <motion.button 
              whileTap={{ scale: 0.9 }}
              onClick={toggleDarkMode}
              className="p-2.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl text-[#707A3E] dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-all shadow-sm"
              aria-label="Toggle Theme"
            >
              {darkMode ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
            </motion.button>
            <motion.button 
              whileTap={{ scale: 0.9 }}
              onClick={() => setView('about')}
              className="p-2.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl text-[#707A3E] dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-all shadow-sm"
              aria-label="Help"
            >
              <HelpCircle className="w-5 h-5" />
            </motion.button>
          </div>
        </header>

        {isOffline && (
          <div className="fixed top-0 left-0 right-0 z-[300] bg-orange-600 text-white text-[10px] uppercase tracking-[0.2em] font-bold py-1 text-center">
            Device is Offline — Using Local Cache
          </div>
        )}
        {error && (
          <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[200] bg-red-500 text-white px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3">
            <AlertCircle className="w-5 h-5" />
            <span className="font-medium">{error}</span>
            <button onClick={() => setError(null)} className="ml-4 opacity-50 hover:opacity-100">×</button>
          </div>
        )}
        <div className="flex-1 flex flex-col overflow-hidden">
          <AnimatePresence>
            {!role ? (
              <HomeScreen key="home" onSelectRole={setRole} />
            ) : !user ? (
              <motion.div 
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex-1 flex flex-col items-center justify-center p-6 text-center"
              >
                <div className="w-16 h-16 bg-[#707A3E]/10 rounded-2xl flex items-center justify-center mb-6 text-[#707A3E]">
                  <Clock className="w-8 h-8 animate-pulse" />
                </div>
                <h2 className="text-2xl font-bold mb-2">Setting up session...</h2>
                <p className="text-neutral-400 max-w-sm mb-8">
                  {error || "Please wait while we connect to the secure focus network."}
                </p>
                {error && (
                  <button 
                    onClick={() => window.location.reload()}
                    className="px-8 py-3 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl font-medium hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-all shadow-sm"
                  >
                    Retry Connection
                  </button>
                )}
              </motion.div>
            ) : role === 'ADMIN' ? (
              <AdminFlow 
                key="admin" 
                onBack={() => {
                  localStorage.removeItem('active_role');
                  localStorage.removeItem('active_session_code');
                  setRole(null);
                }} 
                user={user!} 
              />
            ) : (
              <BuddyFlow 
                key="buddy" 
                onBack={() => {
                  localStorage.removeItem('active_role');
                  localStorage.removeItem('active_session_code');
                  setRole(null);
                }} 
                user={user!} 
              />
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
    </ErrorBoundary>
  );
}

function HomeScreen({ onSelectRole }: { onSelectRole: (role: Role) => void, key?: string }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -20 }}
      className="flex flex-col items-center text-center flex-1 py-4 sm:py-8"
    >
      <motion.div 
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", damping: 15 }}
        className="w-16 h-16 sm:w-20 sm:h-20 bg-gradient-to-br from-[#707A3E] to-[#555D2F] rounded-[1.5rem] flex items-center justify-center mb-6 shadow-2xl shadow-[#707A3E]/30"
      >
        <Shield className="w-8 h-8 sm:w-10 sm:h-10 text-white" />
      </motion.div>
      <h1 className="text-2xl sm:text-3xl font-black tracking-tight mb-2 text-[#707A3E] dark:text-[#E1E8C1]">
        Focus Buddy
      </h1>
      <p className="text-neutral-500 dark:text-neutral-400 mb-8 sm:mb-10 leading-relaxed text-xs sm:text-sm max-w-[240px]">
        Stay productive with remote-controlled focus sessions.
      </p>

      <div className="grid grid-cols-1 gap-4 w-full max-w-[320px]">
        <motion.button 
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => onSelectRole('ADMIN')}
          className="group relative overflow-hidden bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-5 rounded-[1.5rem] text-left transition-all hover:border-[#707A3E]/50 shadow-sm hover:shadow-lg"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="p-2.5 bg-[#707A3E]/10 rounded-xl text-[#707A3E]">
              <Shield className="w-5 h-5" />
            </div>
            <ArrowRight className="w-4 h-4 text-neutral-300 group-hover:text-[#707A3E] transition-colors" />
          </div>
          <h3 className="text-lg font-bold mb-0.5 text-neutral-900 dark:text-white">Admin Device</h3>
          <p className="text-neutral-500 dark:text-neutral-400 text-[11px]">Manage sessions and monitor buddies.</p>
        </motion.button>

        <motion.button 
          whileHover={{ y: -2 }}
          whileTap={{ scale: 0.98 }}
          onClick={() => onSelectRole('BUDDY')}
          className="group relative overflow-hidden bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-5 rounded-[1.5rem] text-left transition-all hover:border-[#707A3E]/50 shadow-sm hover:shadow-lg"
        >
          <div className="flex items-center justify-between mb-3">
            <div className="p-2.5 bg-[#707A3E]/10 rounded-xl text-[#707A3E]">
              <Smartphone className="w-5 h-5" />
            </div>
            <ArrowRight className="w-4 h-4 text-neutral-300 group-hover:text-[#707A3E] transition-colors" />
          </div>
          <h3 className="text-lg font-bold mb-0.5 text-neutral-900 dark:text-white">Buddy Device</h3>
          <p className="text-neutral-500 dark:text-neutral-400 text-[11px]">Join a session and stay focused.</p>
        </motion.button>
      </div>
      
      <div className="mt-auto pt-8 text-[8px] font-bold text-neutral-300 dark:text-neutral-800 uppercase tracking-[0.4em]">
        Secured by ML Kit
      </div>
    </motion.div>
  );
}

const verifyAdminBiometrics = async (): Promise<boolean> => {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) {
    return window.confirm("Authorize this action with security confirmation?");
  }
  try {
    const isAvailable = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    if (!isAvailable) {
      return window.confirm("Authorize this action with security confirmation?");
    }

    const challenge = new Uint8Array(32);
    window.crypto.getRandomValues(challenge);

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: "FocusBuddy Security" },
        user: {
          id: new Uint8Array([1, 2, 3, 4]),
          name: "admin@focusbuddy",
          displayName: "Admin User",
        },
        pubKeyCredParams: [{ alg: -7, type: "public-key" }], // ES256
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          userVerification: "required",
        },
        timeout: 60000,
      },
    });
    return credential !== null;
  } catch (e) {
    console.warn("Biometric verification failed, using confirmation dialog:", e);
    return window.confirm("Biometric verification failed/cancelled. Continue with standard confirmation?");
  }
};

// --- Admin Flow ---

const ESSENTIAL_APPS = [
  { label: "Focus Buddy", packageName: "com.focusbuddy" },
  { label: "Phone", packageName: "com.android.dialer" },
  { label: "Messages", packageName: "com.google.android.apps.messaging" },
  { label: "Clock", packageName: "com.google.android.deskclock" },
  { label: "Calculator", packageName: "com.google.android.calculator" },
  { label: "Calendar", packageName: "com.google.android.calendar" },
  { label: "Camera", packageName: "com.android.camera" },
  { label: "Emergency", packageName: "com.android.emergency" }
];

// --- App List Modal ---
function AppListModal({ buddy, session, onClose }: { buddy: Buddy, session: Session, onClose: () => void }) {
  const [deviceApps, setDeviceApps] = useState<AppInfo[]>([]);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (buddy.installedApps && buddy.installedApps.length > 0) {
      setDeviceApps(buddy.installedApps);
    }
  }, [buddy.installedApps]);

  const HIGH_RISK_PACKAGES = new Set([
    'com.android.chrome', 'com.brave.browser', 'org.mozilla.firefox',
    'com.microsoft.emmx', 'com.opera.browser', 'com.sec.android.app.sbrowser',
    'com.mi.globalbrowser', 'com.android.browser',
    'com.android.vending', 'com.sec.android.app.samsungapps',
    'com.xiaomi.market', 'com.heytap.market',
    'com.instagram.android', 'com.whatsapp', 'com.snapchat.android',
    'com.discord', 'com.telegram.messenger', 'com.twitter.android',
    'com.facebook.katana', 'com.zhiliaoapp.musically', 'com.reddit.frontpage',
    'com.linkedin.android', 'com.pinterest',
    'com.netflix.mediaclient', 'com.amazon.avod.thirdpartyclient',
    'com.google.android.youtube', 'com.spotify.music',
    'com.valvesoftware.android.steam.community', 'com.epicgames.portal',
  ]);

  const toggleApp = async (packageName: string) => {
    const isWhitelisted = buddy.whitelistedApps.includes(packageName);
    
    if (!isWhitelisted && HIGH_RISK_PACKAGES.has(packageName)) {
      const confirmed = window.confirm(
        `⚠️ HIGH RISK APP WARNING\n\n` +
        `Whitelisting "${packageName}" can easily bypass focus mode:\n` +
        `• Browsers provide unrestricted internet access\n` +
        `• Messaging/Social media apps contain in-app browsers\n` +
        `• App stores allow installing third-party tools\n\n` +
        `Are you sure you want to whitelist this app?`
      );
      if (!confirmed) return;
    }

    const biometricsVerified = await verifyAdminBiometrics();
    if (!biometricsVerified) return;

    const newWhitelist = isWhitelisted
      ? buddy.whitelistedApps.filter(p => p !== packageName)
      : [...buddy.whitelistedApps, packageName];

    try {
      await updateDoc(doc(db, 'sessions', session.id, 'buddies', buddy.id), {
        whitelistedApps: newWhitelist
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}`);
    }
  };

  const filteredApps = deviceApps.filter(a => 
    a.label.toLowerCase().includes(search.toLowerCase()) || 
    a.packageName.toLowerCase().includes(search.toLowerCase())
  ).sort((a, b) => {
    // 1. Essentials at the bottom
    const aEssential = ESSENTIAL_APPS.some(e => e.packageName === a.packageName);
    const bEssential = ESSENTIAL_APPS.some(e => e.packageName === b.packageName);
    if (aEssential && !bEssential) return 1;
    if (!aEssential && bEssential) return -1;
    
    // 2. Whitelisted first (within non-essentials)
    const aWhite = buddy.whitelistedApps.includes(a.packageName);
    const bWhite = buddy.whitelistedApps.includes(b.packageName);
    if (aWhite && !bWhite) return -1;
    if (!aWhite && bWhite) return 1;
    
    return a.label.localeCompare(b.label);
  });

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center px-6">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-black/80 backdrop-blur-sm" />
      <motion.div initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }} className="relative w-full max-w-lg bg-white dark:bg-neutral-900 p-6 rounded-[2.5rem] flex flex-col max-h-[85vh] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-xl font-black tracking-tight">{buddy.name}'s Apps</h3>
          <button onClick={onClose} className="p-2 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded-full transition-colors">
            <XCircle className="w-5 h-5 text-neutral-400" />
          </button>
        </div>

        <div className="relative mb-6">
          <input 
            type="text" 
            placeholder="Search installed apps..." 
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-neutral-100 dark:bg-neutral-800 border-none rounded-2xl py-4 pl-12 pr-4 text-sm font-bold placeholder:text-neutral-400 focus:ring-2 focus:ring-[#707A3E]/30 transition-all"
          />
          <div className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400">
            <Plus className="w-5 h-5" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-1 space-y-2 custom-scrollbar">
          {filteredApps.length === 0 ? (
            <div className="text-center py-12 text-neutral-400 text-sm font-bold uppercase tracking-widest">No apps found</div>
          ) : (
            filteredApps.map(app => (
              <div key={app.packageName} className={cn(
                "flex items-center justify-between p-3 rounded-2xl border transition-all",
                buddy.whitelistedApps.includes(app.packageName) 
                  ? "bg-[#707A3E]/5 border-[#707A3E]/20" 
                  : "bg-white dark:bg-neutral-900 border-neutral-100 dark:border-neutral-800"
              )}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl overflow-hidden bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center p-1.5 border border-neutral-200 dark:border-neutral-700">
                    {app.icon ? (
                      <img src={app.icon.startsWith('data:') ? app.icon : `data:image/png;base64,${app.icon}`} alt="" className="w-full h-full object-contain" />
                    ) : (
                      <Smartphone className="w-5 h-5 text-neutral-300" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <div className="font-bold text-xs truncate max-w-[150px]">{app.label}</div>
                    <div className="text-[9px] text-neutral-400 truncate max-w-[150px] font-mono">{app.packageName}</div>
                  </div>
                </div>
                <button 
                  onClick={() => toggleApp(app.packageName)}
                  className={cn(
                    "px-4 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all",
                    buddy.whitelistedApps.includes(app.packageName)
                      ? "bg-[#707A3E] text-white shadow-lg shadow-[#707A3E]/20"
                      : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 hover:bg-neutral-200"
                  )}
                >
                  {buddy.whitelistedApps.includes(app.packageName) ? "Approved" : "Allow"}
                </button>
              </div>
            ))
          )}
        </div>
      </motion.div>
    </div>
  );
}

function AdminFlow({ onBack, user }: { onBack: () => void, user: FirebaseUser, key?: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [buddies, setBuddies] = useState<Buddy[]>([]);
  const [creating, setCreating] = useState(false);
  const [duration, setDuration] = useState<number>(25);
  const [customDuration, setCustomDuration] = useState('');
  const [countdown, setCountdown] = useState<number | null>(null);
  const [lastSession, setLastSession] = useState<{ id: string, duration: number, endedAt: Date } | null>(null);
  const [isServiceActive, setIsServiceActive] = useState(true); // Default to true to avoid flicker
  const [loadingSession, setLoadingSession] = useState(false);
  const isEnded = session?.status === 'ended';
  const isPaused = session?.status === 'paused';
  const isActive = session?.status === 'active';

  useEffect(() => {
    // Reconnect to active session if admin
    const checkActiveSession = async () => {
      setLoadingSession(true);
      try {
        const q = query(
          collection(db, 'sessions'), 
          where('adminDeviceId', '==', user.uid),
          where('status', 'in', ['lobby', 'active', 'paused', 'countdown'])
        );
        const querySnap = await getDocs(q);
        if (!querySnap.empty) {
          const docs = [...querySnap.docs].sort((a, b) => {
            const tA = a.data().timestamp?.toDate?.()?.getTime() || 0;
            const tB = b.data().timestamp?.toDate?.()?.getTime() || 0;
            return tB - tA; // most recent first
          });
          const s = docs[0];
          const data = s.data();
          
          // Check if session is actually stale (e.g., status is active but time is long gone)
          // We'll let the user decide but load it for now
          setSession({ id: s.id, ...data } as Session);
          localStorage.setItem('active_role', 'ADMIN');
        }
      } catch (e) {
        console.error("Admin check failed:", e);
      }
      setLoadingSession(false);
    };
    checkActiveSession();
  }, [user.uid]);

  useEffect(() => {
    if (!session || !session.id || isEnded) return;
    
    // Heartbeat: update lastActive every 20 seconds
    const interval = setInterval(async () => {
      try {
        await updateDoc(doc(db, 'sessions', session.id), {
          lastActive: serverTimestamp()
        });
      } catch (err) {
        console.error("Heartbeat error:", err);
      }
    }, 20000);

    return () => clearInterval(interval);
  }, [session?.id, session?.status, isEnded]);

  useEffect(() => {
    const checkStatus = () => {
      if (window.Android && window.Android.isAccessibilityEnabled) {
        setIsServiceActive(window.Android.isAccessibilityEnabled());
      }
    };
    const interval = setInterval(checkStatus, 2000);
    checkStatus();
    return () => clearInterval(interval);
  }, []);

  // Helper component for the blocking alert
  const BlockingAlert = () => {
    if (isServiceActive) return null;
    
    return (
      <motion.div 
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        className="mb-6 bg-red-600 rounded-3xl p-5 text-white shadow-xl shadow-red-600/20"
      >
        <div className="flex items-center gap-3 mb-2">
          <AlertCircle className="w-5 h-5" />
          <h4 className="font-black text-sm uppercase tracking-widest leading-tight">Blocking Disabled</h4>
        </div>
        <p className="text-[11px] opacity-90 leading-relaxed mb-4">
          Accessibility service is required for 24/7 app blocking. Focus Mode won't be able to lock your device without this.
        </p>
        <button 
          onClick={() => {
              if (window.Android) window.Android.openAccessibilitySettings();
              else alert("Running in browser: Open Settings > Accessibility > Focus Buddy manually.");
          }}
          className="w-full py-3 bg-white text-red-600 rounded-xl font-black uppercase tracking-widest text-[10px] active:scale-95 transition-transform"
        >
          Enable Accessibility
        </button>
      </motion.div>
    );
  };

  useEffect(() => {
    if (session) {
      const unsubBuddies = onSnapshot(collection(db, 'sessions', session.id, 'buddies'), (snapshot) => {
        setBuddies(snapshot.docs.map(d => ({ id: d.id, ...d.data() } as Buddy)));
      });
      const unsubSession = onSnapshot(doc(db, 'sessions', session.id), (doc) => {
        if (doc.exists()) {
          setSession({ id: doc.id, ...doc.data() } as Session);
        }
      });
      return () => {
        unsubBuddies();
        unsubSession();
      };
    }
  }, [session?.id]);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (countdown !== null && countdown > 0) {
      timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    } else if (countdown === 0) {
      startSessionActual();
      setCountdown(null);
    }
    return () => clearTimeout(timer);
  }, [countdown]);

  const [selectedBuddyId, setSelectedBuddyId] = useState<string | null>(null);
  const selectedBuddyForWhitelist = buddies.find(b => b.id === selectedBuddyId);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const [sessionTime, setSessionTime] = useState(0);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if ((session?.status === 'active' || session?.status === 'paused') && session.startTime) {
      const start = session.startTime.toDate ? session.startTime.toDate().getTime() : session.startTime;
      const checkAndSetTime = () => {
        const now = session.status === 'paused' && session.pausedAt 
          ? (session.pausedAt.toDate ? session.pausedAt.toDate().getTime() : session.pausedAt)
          : Date.now();
        const elapsed = Math.floor((now - start) / 1000);
        const pausedSeconds = session.accumulatedPausedSeconds || 0;
        const remaining = Math.max(0, session.timerSeconds - elapsed + pausedSeconds);
        setSessionTime(remaining);
        
        if (remaining <= 0) {
          if (timer) clearInterval(timer);
          // Auto end the session
          if (window.Android && window.Android.stopFocusSession) {
            window.Android.stopFocusSession(getSessionToken());
          }
          const endedAt = new Date();
          updateDoc(doc(db, 'sessions', session.id), {
            status: 'ended',
            focusActive: false,
            endedAt: serverTimestamp()
          }).then(() => {
            setLastSession({ id: session.id, duration: session.timerSeconds, endedAt });
            setSession(null);
            console.log('Session auto-ended after reaching 0:00');
          }).catch(err => {
            console.error('Failed to auto-end session:', err);
          });
          return true; // ended
        }
        return false;
      };

      const ended = checkAndSetTime();
      if (!ended && session.status === 'active') {
        timer = setInterval(checkAndSetTime, 1000);
      }
    }
    return () => clearInterval(timer);
  }, [session?.status, session?.startTime, session?.timerSeconds, session?.pausedAt, session?.accumulatedPausedSeconds]);

  const createSession = async () => {
    const generateSessionCode = (): string => {
      const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I/L
      const bytes = new Uint8Array(10);
      crypto.getRandomValues(bytes);
      return Array.from(bytes).map(b => alphabet[b % alphabet.length]).join('');
    };
    const code = generateSessionCode();
    const finalDuration = customDuration ? parseInt(customDuration) : duration;
    
    const sessionData: Omit<Session, 'id'> = {
      focusActive: false,
      adminDeviceId: user.uid,
      timestamp: serverTimestamp(),
      timerSeconds: finalDuration * 60,
      status: 'lobby',
      buddyIds: []
    };

    try {
      await setDoc(doc(db, 'sessions', code), sessionData);
      setSession({ id: code, ...sessionData });
      setCreating(false);
      console.log('Session created successfully:', code);
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, `sessions/${code}`);
    }
  };

  const startSession = () => {
    if (!session) return;
    const countdownEndsAt = Date.now() + 10000;
    setCountdown(10);
    updateDoc(doc(db, 'sessions', session.id), { 
      status: 'countdown',
      countdownEndsAt: countdownEndsAt
    });
  };

  const startSessionActual = async () => {
    if (!session) return;
    try {
      await updateDoc(doc(db, 'sessions', session.id), {
        status: 'active',
        focusActive: true,
        startTime: serverTimestamp()
      });
      console.log('Session started');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}`);
    }
  };

  const stopSession = async () => {
    if (!session) return;
    const verified = await verifyAdminBiometrics();
    if (!verified) return;
    try {
      // Release hardware blocker
      if (window.Android && window.Android.stopFocusSession) {
        window.Android.stopFocusSession(getSessionToken());
      }

      const endedAt = new Date();
      await updateDoc(doc(db, 'sessions', session.id), {
        status: 'ended',
        focusActive: false,
        endedAt: serverTimestamp()
      });
      setLastSession({ id: session.id, duration: session.timerSeconds, endedAt });
      setSession(null);
      console.log('Session stopped');
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}`);
    }
  };

  const toggleApp = async (buddyId: string, packageName: string) => {
    console.log('Toggling app:', packageName, 'for buddy:', buddyId);
    if (!session) return;
    const buddy = buddies.find(b => b.id === buddyId);
    if (!buddy) return;

    const newWhitelist = buddy.whitelistedApps.includes(packageName)
      ? buddy.whitelistedApps.filter(p => p !== packageName)
      : [...buddy.whitelistedApps, packageName];

    try {
      await updateDoc(doc(db, 'sessions', session.id, 'buddies', buddyId), {
        whitelistedApps: newWhitelist
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}/buddies/${buddyId}`);
    }
  };

  const approveBuddy = async (buddyId: string) => {
    if (!session) return;
    const verified = await verifyAdminBiometrics();
    if (!verified) return;
    try {
      await updateDoc(doc(db, 'sessions', session.id, 'buddies', buddyId), {
        status: 'approved'
      });
      console.log('Buddy approved:', buddyId);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}/buddies/${buddyId}`);
    }
  };

  const removeBuddy = async (buddyId: string) => {
    if (!session) return;
    try {
      await deleteDoc(doc(db, 'sessions', session.id, 'buddies', buddyId));
      console.log('Buddy removed:', buddyId);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `sessions/${session.id}/buddies/${buddyId}`);
    }
  };

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (session) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [session]);

  const handleExit = async () => {
    if (session) {
      const confirmEnd = window.confirm("Are you sure you want to end this session? All buddies will be kicked and redirects will happen.");
      if (!confirmEnd) return;

      if (session.status === 'active' || session.status === 'paused' || session.status === 'countdown') {
        try {
          if (window.Android && window.Android.stopFocusSession) {
            window.Android.stopFocusSession(localStorage.getItem('session_token') || '');
          }
          await updateDoc(doc(db, 'sessions', session.id), {
            status: 'ended',
            focusActive: false,
            endedAt: serverTimestamp()
          });
          onBack();
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}`);
          onBack();
        }
      } else {
        onBack();
      }
    } else {
      onBack();
    }
  };

  useEffect(() => {
    const handleAndroidBack = () => {
      handleExit();
    };
    window.addEventListener('androidBack', handleAndroidBack);
    return () => window.removeEventListener('androidBack', handleAndroidBack);
  }, [session]);

  if (isEnded) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[#FDFBF0] dark:bg-neutral-950">
        <div className="w-20 h-20 bg-green-500 rounded-[2rem] flex items-center justify-center mb-6 shadow-2xl shadow-green-500/20">
          <CheckCircle2 className="w-10 h-10 text-white" />
        </div>
        <h2 className="text-3xl font-black mb-3">Session Ended</h2>
        <p className="text-neutral-500 dark:text-neutral-400 mb-8 max-w-xs mx-auto font-medium">
          The focus mode was successfully completed. All buddy devices have been released.
        </p>
        <button 
          onClick={onBack}
          className="bg-[#707A3E] text-white px-12 py-4 rounded-2xl font-black uppercase tracking-widest text-xs shadow-lg shadow-[#707A3E]/20"
        >
          Return Home
        </button>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <BlockingAlert />
      <div className="flex items-center justify-between mb-6 flex-shrink-0">
        <motion.button 
          whileTap={{ scale: 0.9 }}
          onClick={handleExit} 
          className="p-2.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl shadow-sm transition-colors"
        >
          <ArrowLeft className="w-5 h-5 text-[#707A3E]" />
        </motion.button>
        <div className="text-center">
          <h2 className="text-lg font-black tracking-tight">Admin Dashboard</h2>
          <div className={cn(
            "text-[8px] uppercase tracking-[0.2em] font-bold mt-0.5",
            session?.status === 'active' ? "text-green-500" : 
            session?.status === 'paused' ? "text-yellow-500" :
            session?.status === 'countdown' ? "text-[#707A3E]" :
            session?.status === 'ended' ? "text-red-500" : "text-neutral-500"
          )}>
            {session ? (session.status === 'lobby' ? 'Not Started' : `Session ${session.status.replace(/^\w/, c => c.toUpperCase())}`) : 'No Session'}
          </div>
        </div>
        <div className="w-10" />
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
        {!session ? (
          <div className="space-y-6">
            {lastSession && (
              <motion.div 
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-green-500/10 border border-green-500/20 p-5 rounded-3xl text-center"
              >
                <div className="text-green-500 text-xs font-black uppercase tracking-widest mb-1">Previous Session Ended</div>
                <div className="text-neutral-500 text-[11px] font-medium">
                  Session {lastSession.id} • {Math.floor(lastSession.duration / 60)}m • {lastSession.endedAt.toLocaleTimeString()}
                </div>
              </motion.div>
            )}

            <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-neutral-200 dark:border-neutral-800 rounded-[2rem] px-4 text-center">
              <div className="w-12 h-12 bg-neutral-100 dark:bg-neutral-800 rounded-2xl flex items-center justify-center mb-4">
                <Plus className="w-6 h-6 text-neutral-400" />
              </div>
              <h3 className="text-base font-bold mb-4">No active session</h3>
              <motion.button 
                whileTap={{ scale: 0.95 }}
                onClick={() => setCreating(true)}
                className="w-full max-w-[200px] bg-[#707A3E] hover:bg-[#555D2F] text-white py-3 rounded-xl font-black uppercase tracking-widest text-[10px] transition-all shadow-lg shadow-[#707A3E]/20"
              >
                Create Session
              </motion.button>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Session Header */}
            <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-6 rounded-[2rem] flex flex-col items-center text-center gap-4 shadow-sm">
              <div>
                <div className="text-neutral-400 text-[8px] uppercase tracking-[0.2em] font-bold mb-1">Session Code</div>
                <div className="flex items-center gap-3">
                  <div className="text-5xl font-mono font-black text-[#707A3E] dark:text-[#E1E8C1] tracking-tight">{session.id}</div>
                  <div className="flex flex-col gap-2 relative">
                    {sessionTime <= 0 && (isActive || isPaused) && (
                      <div className="absolute -top-3 -right-3 z-20">
                        <motion.button 
                          initial={{ scale: 0 }}
                          animate={{ scale: 1 }}
                          whileTap={{ scale: 0.9 }}
                          onClick={stopSession}
                          className="bg-red-500 text-white p-2 rounded-full shadow-xl hover:bg-red-600 transition-colors"
                          title="Force End Stale Session"
                        >
                          <AlertCircle className="w-5 h-5" />
                        </motion.button>
                      </div>
                    )}
                    <motion.button
                      whileTap={{ scale: 0.9 }}
                      onClick={() => {
                        if (window.Android) window.Android.copyToClipboard(session.id);
                        else {
                          navigator.clipboard.writeText(session.id);
                          alert("Code copied to clipboard!");
                        }
                      }}
                      className="p-2 bg-neutral-100 dark:bg-neutral-800 rounded-lg text-neutral-500 hover:text-[#707A3E] transition-colors"
                      title="Copy Code"
                    >
                      <Copy className="w-4 h-4" />
                    </motion.button>
                    <motion.button
                      whileTap={{ scale: 0.9 }}
                      onClick={() => {
                        const message = `Join my Focus Session! Code: ${session.id}`;
                        if (window.Android) window.Android.shareSessionCode(message);
                        else if (navigator.share) {
                          navigator.share({ title: 'Focus Buddy', text: message });
                        } else {
                          alert(message);
                        }
                      }}
                      className="p-2 bg-neutral-100 dark:bg-neutral-800 rounded-lg text-neutral-500 hover:text-[#707A3E] transition-colors"
                      title="Share Session"
                    >
                      <Share2 className="w-4 h-4" />
                    </motion.button>
                  </div>
                </div>
              </div>
              
              <div className="flex flex-wrap justify-center gap-2 w-full">
                {countdown !== null ? (
                  <div className="flex flex-col gap-2 w-full">
                    <div className="bg-[#707A3E]/10 text-[#707A3E] px-6 py-3 rounded-2xl font-bold flex items-center gap-3 border border-[#707A3E]/20 w-full justify-center">
                      <Clock className="w-4 h-4 animate-spin" />
                      Starting in {countdown}s
                    </div>
                    <motion.button
                      whileTap={{ scale: 0.95 }}
                      onClick={async () => {
                        setCountdown(null);
                        await updateDoc(doc(db, 'sessions', session.id), { 
                          status: 'lobby',
                          countdownEndsAt: null 
                        });
                      }}
                      className="w-full flex items-center justify-center gap-2 bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-800 dark:hover:bg-neutral-700 text-neutral-800 dark:text-neutral-200 py-3 rounded-xl font-bold uppercase tracking-widest text-[9px] transition-all"
                    >
                      Cancel Countdown
                    </motion.button>
                  </div>
                ) : (
                  <>
                    {(!session.status || session.status === 'lobby') && (
                      <motion.button 
                        whileTap={{ scale: 0.95 }}
                        onClick={startSession}
                        disabled={buddies.length === 0 || buddies.some(b => b.status !== 'approved' || !b.faceImage)}
                        className="w-full flex items-center justify-center gap-2 bg-[#707A3E] hover:bg-[#555D2F] disabled:opacity-50 disabled:cursor-not-allowed text-white py-4 rounded-2xl font-black uppercase tracking-widest text-[10px] transition-all shadow-lg shadow-[#707A3E]/20"
                      >
                        <Play className="w-4 h-4" /> Start Session
                      </motion.button>
                    )}
                    {session.status === 'active' && (
                      <div className="bg-[#707A3E]/10 text-[#707A3E] px-6 py-3 rounded-2xl font-mono font-black flex items-center gap-3 border border-[#707A3E]/20 text-2xl w-full justify-center">
                        <Clock className="w-5 h-5" />
                        {formatTime(sessionTime)}
                      </div>
                    )}
                    <div className="flex gap-2 w-full">
                      {session.status === 'active' && (
                        <motion.button 
                          whileTap={{ scale: 0.95 }}
                          onClick={() => updateDoc(doc(db, 'sessions', session.id), { 
                            status: 'paused', 
                            focusActive: false,
                            pausedAt: serverTimestamp()
                          })}
                          className="flex-1 flex items-center justify-center gap-2 bg-yellow-500 hover:bg-yellow-600 text-white py-3.5 rounded-2xl font-bold transition-all text-xs shadow-lg shadow-yellow-500/20"
                        >
                          <Pause className="w-4 h-4" /> Pause
                        </motion.button>
                      )}
                      {session.status === 'paused' && (
                        <motion.button 
                          whileTap={{ scale: 0.95 }}
                          onClick={async () => {
                            try {
                              const sessionSnap = await getDoc(doc(db, 'sessions', session.id));
                              const data = sessionSnap.data();
                              if (data) {
                                const pausedAt = data.pausedAt?.toDate?.()?.getTime() || new Date(data.pausedAt).getTime();
                                const pausedDuration = Math.floor((Date.now() - pausedAt) / 1000);
                                const newAccumulated = (data.accumulatedPausedSeconds || 0) + pausedDuration;
                                await updateDoc(doc(db, 'sessions', session.id), {
                                  status: 'active',
                                  focusActive: true,
                                  pausedAt: null,
                                  accumulatedPausedSeconds: newAccumulated
                                });
                              }
                            } catch (err) {
                              console.error("Resume failed:", err);
                            }
                          }}
                          className="flex-1 flex items-center justify-center gap-2 bg-[#707A3E] hover:bg-[#555D2F] text-white py-3.5 rounded-2xl font-bold transition-all text-xs shadow-lg shadow-[#707A3E]/20"
                        >
                          <Play className="w-4 h-4" /> Resume
                        </motion.button>
                      )}
                      {(session.status === 'active' || session.status === 'paused') && (
                        <motion.button 
                          whileTap={{ scale: 0.95 }}
                          onClick={stopSession}
                          className="flex-1 flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 text-white py-3.5 rounded-2xl font-bold transition-all text-xs shadow-lg shadow-red-500/20"
                        >
                          <Square className="w-4 h-4" /> Stop
                        </motion.button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Buddies Section */}
            <div className="space-y-4">
              <div className="flex items-center justify-between px-2">
                <h3 className="text-sm font-black uppercase tracking-widest text-neutral-400">Connected Buddies</h3>
                <span className="bg-[#707A3E]/10 text-[#707A3E] text-[10px] font-bold px-2 py-0.5 rounded-full border border-[#707A3E]/20">
                  {buddies.length}
                </span>
              </div>
              
              <div className="grid grid-cols-1 gap-3">
                {buddies.map(buddy => (
                  <div key={buddy.id} className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-4 rounded-[1.5rem] shadow-sm">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-[#707A3E]/10 rounded-xl flex items-center justify-center text-[#707A3E]">
                          <User className="w-5 h-5" />
                        </div>
                        <div>
                          <div className="font-bold text-sm">{buddy.name}</div>
                          <div className="text-[10px] text-neutral-400 font-mono">{buddy.deviceId.slice(0, 8)}</div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                      <div className={cn(
                        "px-2 py-0.5 rounded-full text-[8px] font-black uppercase tracking-widest border",
                        buddy.status === 'approved' ? "bg-green-500/10 text-green-500 border-green-500/20" : "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                      )}>
                        {buddy.status}
                      </div>
                      <div className="flex items-center gap-1 text-[8px] font-bold text-neutral-400">
                        <div className={cn("w-1.5 h-1.5 rounded-full", buddy.isOnline ? "bg-green-500" : "bg-neutral-300")} />
                        {buddy.isOnline ? 'Online' : 'Offline'}
                      </div>
                    </div>
                  </div>

                  {/* Recognition Status Alert */}
                  {buddy.pausedByFace && buddy.status === 'approved' && !isEnded && (
                    <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-2 text-red-500 text-[10px] font-black uppercase tracking-widest animate-pulse">
                      <AlertCircle className="w-4 h-4" /> Buddy Detected Stranger
                    </div>
                  )}

                  {/* Active Requests */}
                  {(buddy.requestStop || buddy.requestPause) && (
                    <div className="mb-4 p-4 bg-yellow-500/10 border border-yellow-500/20 rounded-2xl flex flex-col gap-3">
                      <div className="flex items-center gap-2 text-yellow-600 font-black text-[10px] uppercase tracking-widest leading-none">
                        <AlertCircle className="w-4 h-4" /> Buddy Alert
                      </div>
                      {buddy.requestStop && (
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold">Wants to STOP session</span>
                          <motion.button 
                            whileTap={{ scale: 0.9 }}
                            onClick={() => stopSession()}
                            className="px-3 py-1 bg-red-500 text-white rounded-lg text-[8px] font-black uppercase tracking-widest"
                          >
                            End Session
                          </motion.button>
                        </div>
                      )}
                      {buddy.requestPause && (
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold">Wants to PAUSE session</span>
                          <motion.button 
                            whileTap={{ scale: 0.9 }}
                            onClick={async () => {
                              await updateDoc(doc(db, 'sessions', session.id), { status: 'paused', focusActive: false });
                              await updateDoc(doc(db, 'sessions', session.id, 'buddies', buddy.id), { requestPause: false });
                            }}
                            className="px-3 py-1 bg-yellow-500 text-white rounded-lg text-[8px] font-black uppercase tracking-widest"
                          >
                            Pause Now
                          </motion.button>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Profile Verification */}
                  {buddy.status === 'pending' && (
                    <div className="p-4 bg-neutral-50 dark:bg-neutral-800/50 rounded-2xl border border-neutral-200 dark:border-neutral-700 mb-4">
                      <div className="text-[8px] text-neutral-400 font-black uppercase tracking-widest mb-3">Verification Step</div>
                      <div className="flex items-center gap-4 mb-4">
                        {buddy.faceImage ? (
                          <img src={buddy.faceImage} alt="Identity" className="w-16 h-16 rounded-2xl object-cover border-2 border-green-500 shadow-lg shadow-green-500/20" />
                        ) : (
                          <div className="w-16 h-16 bg-neutral-200 dark:bg-neutral-800 rounded-2xl flex items-center justify-center text-neutral-400">
                            <Camera className="w-8 h-8" />
                          </div>
                        )}
                        <div className="flex-1">
                          <div className="text-[10px] text-neutral-500 font-bold mb-1">Face Profile</div>
                          <div className="text-[12px] font-black uppercase tracking-tight leading-none">{buddy.faceImage ? 'Ready to Start' : 'Waiting for Face'}</div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <motion.button 
                          whileTap={{ scale: 0.95 }}
                          disabled={!buddy.faceImage}
                          onClick={() => approveBuddy(buddy.id)}
                          className="flex-1 bg-[#707A3E] disabled:opacity-30 text-white py-2.5 rounded-xl font-black uppercase tracking-widest text-[9px] shadow-sm active:scale-95 transition-all"
                        >
                          Approve
                        </motion.button>
                        <motion.button 
                          whileTap={{ scale: 0.95 }}
                          onClick={() => removeBuddy(buddy.id)}
                          className="px-4 bg-red-500/10 text-red-500 rounded-xl font-bold text-[9px] uppercase tracking-widest"
                        >
                          Reject
                        </motion.button>
                      </div>
                      {!buddy.faceImage && (
                        <p className="text-[8px] text-red-500 mt-2 font-bold text-center animate-pulse">Session cannot start until buddy registers face.</p>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2 mt-auto">
                    <button 
                      onClick={() => setSelectedBuddyId(buddy.id)}
                      className="flex-1 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 py-3 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 shadow-sm"
                    >
                      <Lock className="w-3 h-3" /> Manage Apps
                    </button>
                    {buddy.status === 'approved' && (
                       <button 
                        onClick={() => removeBuddy(buddy.id)}
                        className="p-3 bg-red-500/5 text-red-500/40 hover:text-red-500 border border-transparent hover:border-red-500/20 rounded-xl transition-all"
                      >
                         <UserX className="w-4 h-4" />
                       </button>
                    )}
                  </div>
                </div>
              ))}
                {buddies.length === 0 && (
                  <div className="py-8 text-center border-2 border-dashed border-neutral-100 dark:border-neutral-900 rounded-[1.5rem]">
                    <p className="text-xs font-bold text-neutral-400 uppercase tracking-widest">Waiting for buddies...</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Whitelist Modal */}
      <AnimatePresence>
        {selectedBuddyId && selectedBuddyForWhitelist && (
          <AppListModal 
            buddy={selectedBuddyForWhitelist} 
            session={session!} 
            onClose={() => setSelectedBuddyId(null)} 
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {creating && (
          <div className="fixed inset-0 z-50 flex items-center justify-center px-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setCreating(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-md bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-8 rounded-[2.5rem] shadow-2xl"
            >
              <h3 className="text-2xl font-black mb-6 tracking-tight">Session Duration</h3>
              <div className="grid grid-cols-2 gap-3 mb-8">
                {[25, 45, 60, 90].map(m => (
                  <motion.button 
                    key={m}
                    whileTap={{ scale: 0.95 }}
                    onClick={() => { setDuration(m); setCustomDuration(''); }}
                    className={cn(
                      "p-5 rounded-[1.5rem] border transition-all text-center group",
                      duration === m && !customDuration ? "border-[#707A3E] bg-[#707A3E]/10 text-[#707A3E]" : "border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-800/50 text-neutral-500 dark:text-neutral-400 hover:border-neutral-300 dark:hover:border-neutral-700 shadow-sm"
                    )}
                  >
                    <div className="text-2xl font-black">{m}</div>
                    <div className="text-[10px] uppercase font-bold tracking-widest opacity-60">minutes</div>
                  </motion.button>
                ))}
              </div>
              <div className="mb-10">
                <label className="text-[10px] font-black text-neutral-400 dark:text-neutral-600 uppercase tracking-[0.2em] mb-3 block px-1">Custom (minutes)</label>
                <input 
                  type="number" 
                  value={customDuration}
                  onChange={(e) => setCustomDuration(e.target.value)}
                  placeholder="Enter minutes..."
                  className="w-full bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-2xl px-5 py-4 focus:outline-none focus:border-[#707A3E] transition-all text-neutral-900 dark:text-white font-bold shadow-sm"
                />
              </div>
              <motion.button 
                whileTap={{ scale: 0.95 }}
                onClick={createSession}
                className="w-full bg-[#707A3E] hover:bg-[#555D2F] text-white py-5 rounded-2xl font-black uppercase tracking-widest text-xs transition-all shadow-lg shadow-[#707A3E]/20"
              >
                Confirm & Create
              </motion.button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

// --- Settings & About Views ---

function AboutView({ onBack }: { onBack: () => void }) {
  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="min-h-screen bg-[#FDFBF0] dark:bg-neutral-950 text-neutral-900 dark:text-neutral-100 p-6 font-sans"
    >
      <div className="max-w-md mx-auto">
        <div className="flex items-center mb-10">
          <motion.button 
            whileTap={{ scale: 0.9 }}
            onClick={onBack} 
            className="p-2.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl transition-all shadow-sm"
          >
            <ArrowLeft className="w-6 h-6 text-[#707A3E]" />
          </motion.button>
          <h2 className="text-2xl font-black ml-4 tracking-tight">About & Help</h2>
        </div>

        <div className="space-y-6">
          <div className="p-8 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-[2rem] shadow-sm">
            <div className="flex items-center gap-4 mb-6">
              <div className="p-3 bg-[#707A3E]/10 rounded-2xl text-[#707A3E]">
                <Info className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold">How it Works</h3>
            </div>
            <div className="space-y-6 text-sm sm:text-base text-neutral-600 dark:text-neutral-400 leading-relaxed">
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-[#707A3E]/10 text-[#707A3E] flex items-center justify-center font-black flex-shrink-0">1</div>
                <p><span className="font-bold text-neutral-900 dark:text-white">Create a Session:</span> Choose your focus duration and get a unique 6-digit code.</p>
              </div>
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-[#707A3E]/10 text-[#707A3E] flex items-center justify-center font-black flex-shrink-0">2</div>
                <p><span className="font-bold text-neutral-900 dark:text-white">Buddy Pairing:</span> Share the code with your buddy. They join from their device to monitor you.</p>
              </div>
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-[#707A3E]/10 text-[#707A3E] flex items-center justify-center font-black flex-shrink-0">3</div>
                <p><span className="font-bold text-neutral-900 dark:text-white">Focus Mode:</span> Once started, your device locks into a distraction-free state. Only apps approved by your buddy are accessible.</p>
              </div>
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-[#707A3E]/10 text-[#707A3E] flex items-center justify-center font-black flex-shrink-0">4</div>
                <p><span className="font-bold text-neutral-900 dark:text-white">Presence Monitoring:</span> Our verification engine ensures it's you. If only a stranger is detected, focus mode pauses automatically to protect your session.</p>
              </div>
              <div className="p-4 bg-yellow-500/5 border border-yellow-500/10 rounded-2xl mt-4">
                <div className="flex items-center gap-2 text-yellow-600 font-black text-[10px] uppercase tracking-widest mb-1">
                  <Camera className="w-3 h-3" /> Why Permissions?
                </div>
                <p className="text-[10px] text-neutral-500 leading-relaxed italic">
                  To provide professional app-locking and biometric face monitoring, Android treats our internal bridge as a secure connection. This is why you see "browser-style" permission prompts—granting them ensures the locking service stays active and the verification engine can detect if a stranger picks up your phone.
                </p>
              </div>
            </div>
          </div>

          <div className="text-center py-12">
            <div className="text-[10px] font-black text-neutral-300 dark:text-neutral-800 uppercase tracking-[0.5em] mb-2">App Version</div>
            <div className="text-sm font-mono font-bold text-neutral-400 dark:text-neutral-600">v1.0.5-stable</div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}

// --- Buddy Flow ---

function BuddyFlow({ onBack, user }: { onBack: () => void, user: FirebaseUser, key?: string }) {
  const [sessionCode, setSessionCode] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [buddy, setBuddy] = useState<Buddy | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [registeringFace, setRegisteringFace] = useState(false);
  const [isServiceActive, setIsServiceActive] = useState(true);
  const [localCountdown, setLocalCountdown] = useState<number | null>(null);

  useEffect(() => {
    if (session?.status === 'countdown' && session.countdownEndsAt) {
      const update = () => {
        const endsAt = session.countdownEndsAt.toDate ? session.countdownEndsAt.toDate().getTime() : session.countdownEndsAt;
        const remaining = Math.ceil((endsAt - Date.now()) / 1000);
        setLocalCountdown(remaining > 0 ? remaining : 0);
      };
      update();
      const interval = setInterval(update, 100);
      return () => clearInterval(interval);
    } else {
      setLocalCountdown(null);
    }
  }, [session?.status, session?.countdownEndsAt]);

  useEffect(() => {
    const checkStatus = () => {
      if (window.Android && window.Android.isAccessibilityEnabled) {
        setIsServiceActive(window.Android.isAccessibilityEnabled());
      }
    };
    const interval = setInterval(checkStatus, 2000);
    checkStatus();
    return () => clearInterval(interval);
  }, []);

  // Helper component for the blocking alert
  const BlockingAlert = () => {
    if (isServiceActive) return null;
    
    return (
      <motion.div 
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        className="mb-6 bg-red-600 rounded-3xl p-5 text-white shadow-xl shadow-red-600/20"
      >
        <div className="flex items-center gap-3 mb-2">
          <AlertCircle className="w-5 h-5" />
          <h4 className="font-black text-sm uppercase tracking-widest leading-tight">Blocking Disabled</h4>
        </div>
        <p className="text-[11px] opacity-90 leading-relaxed mb-4">
          Accessibility service is required for 24/7 app blocking. Focus Mode won't be able to lock your device without this.
        </p>
        <button 
          onClick={() => {
              if (window.Android) window.Android.openAccessibilitySettings();
              else alert("Running in browser: Open Settings > Accessibility > Focus Buddy manually.");
          }}
          className="w-full py-3 bg-white text-red-600 rounded-xl font-black uppercase tracking-widest text-[10px] active:scale-95 transition-transform"
        >
          Enable Accessibility
        </button>
      </motion.div>
    );
  };

  useEffect(() => {
    // Discovery logic: find sessions even if cache was cleared
    const discoverActiveSession = async () => {
      if (session) return;
      setJoining(true);
      try {
        const q = query(
          collection(db, 'sessions'),
          where('buddyIds', 'array-contains', user.uid),
          where('status', '!=', 'ended'),
          limit(1)
        );
        const snap = await getDocs(q);
        if (!snap.empty) {
          const sDoc = snap.docs[0];
          const bRef = doc(db, 'sessions', sDoc.id, 'buddies', user.uid);
          const bSnap = await getDoc(bRef);
          if (bSnap.exists()) {
            setSession({ id: sDoc.id, ...sDoc.data() } as Session);
            setBuddy({ id: user.uid, ...bSnap.data() } as Buddy);
            localStorage.setItem('active_session_code', sDoc.id);
            localStorage.setItem('active_role', 'BUDDY');
          }
        }
      } catch (e) {
        console.error("Discovery failed:", e);
      }
      setJoining(false);
    };
    discoverActiveSession();
  }, [user.uid]);

  useEffect(() => {
    const savedCode = localStorage.getItem('active_session_code');
    const savedRole = localStorage.getItem('active_role');
    
    if (savedCode && savedRole === 'BUDDY' && !session) {
      setJoining(true);
      const reconnect = async () => {
        try {
          const sRef = doc(db, 'sessions', savedCode);
          const sSnap = await getDoc(sRef);
          if (sSnap.exists() && sSnap.data().status !== 'ended') {
            const bRef = doc(db, 'sessions', savedCode, 'buddies', user.uid);
            const bSnap = await getDoc(bRef);
            if (bSnap.exists()) {
              setSession({ id: savedCode, ...sSnap.data() } as Session);
              setBuddy({ id: user.uid, ...bSnap.data() } as Buddy);
            }
          } else {
            localStorage.removeItem('active_session_code');
            localStorage.removeItem('active_role');
          }
        } catch (e) {
          console.error("Reconnection failed:", e);
        }
        setJoining(false);
      };
      reconnect();
    }
  }, [user.uid]);

  useEffect(() => {
    if (session && buddy) {
      if (session.status === 'ended') {
        // Automatically cleanup and stop native side
        if (window.Android && window.Android.stopFocusSession) {
          window.Android.stopFocusSession(getSessionToken());
        }
      }
      
      const unsubSession = onSnapshot(doc(db, 'sessions', session.id), (doc) => {
        const data = doc.data() as Session;
        setSession({ id: doc.id, ...data } as Session);
      });
      const unsubBuddy = onSnapshot(doc(db, 'sessions', session.id, 'buddies', buddy.id), (doc) => {
        if (doc.exists()) {
          setBuddy({ id: doc.id, ...doc.data() } as Buddy);
        } else {
          // Check if session status is not ended (implies rejection)
          if (session && session.status !== 'ended') {
            setError('You were removed from the session by the admin.');
          }
          setSession(null);
          setBuddy(null);
        }
      });
      return () => {
        unsubSession();
        unsubBuddy();
      };
    }
  }, [session?.id, buddy?.id]);

  // Admin presence checker on buddy side
  useEffect(() => {
    if (!session || !session.id || session.status === 'ended') return;
    
    const checkAdminPresence = () => {
      if (!session.lastActive) return;
      const lastActiveTime = session.lastActive.toDate ? session.lastActive.toDate().getTime() : session.lastActive;
      const goneFor = Date.now() - lastActiveTime;
      if (goneFor > 120000) { // 2 minutes
        console.log("Admin presence timeout — auto-ending session");
        if (window.Android && window.Android.stopFocusSession) {
          window.Android.stopFocusSession(getSessionToken());
        }
        
        setError("Admin disconnected. Focus session ended.");
        setSession(null);
        setBuddy(null);
        
        if (session.status === 'active' || session.status === 'paused') {
          updateDoc(doc(db, 'sessions', session.id), {
            status: 'ended',
            focusActive: false,
            endedAt: serverTimestamp()
          }).catch(err => {
            console.error("Failed to set session status to ended:", err);
          });
        }
      }
    };

    const interval = setInterval(checkAdminPresence, 10000); // Check every 10 seconds
    return () => clearInterval(interval);
  }, [session?.id, session?.status, session?.lastActive]);

  const joinSession = async () => {
    if (!sessionCode || !name) {
      setError('Please enter both code and name');
      return;
    }
    setJoining(true);
    setError('');
    try {
      const sessionRef = doc(db, 'sessions', sessionCode);
      const sessionSnap = await getDoc(sessionRef);
      
      if (!sessionSnap.exists()) {
        setError('Session not found');
        setJoining(false);
        return;
      }

      const sessionData = sessionSnap.data() as Session;
      if (sessionData.adminDeviceId === user.uid) {
        setError('You are the admin of this session. Admins cannot join as buddies.');
        setJoining(false);
        return;
      }

      if (sessionData.status === 'ended') {
        setError('This session has already ended.');
        setJoining(false);
        return;
      }

      if (sessionData.status === 'countdown') {
        setError('Session is starting — cannot join right now.');
        setJoining(false);
        return;
      }

      // Fetch reality installed apps
      let installedApps: AppInfo[] = [];
      if (window.Android && window.Android.getInstalledApps) {
        try {
          installedApps = JSON.parse(window.Android.getInstalledApps());
        } catch (e) {
          console.error("Native app fetch failed:", e);
        }
      } else {
        installedApps = MOCK_APPS;
      }

      const buddyId = user.uid;
      const buddyData: Buddy = {
        id: buddyId,
        name,
        deviceId: user.uid,
        status: 'pending',
        installedApps: installedApps.map(a => ({
          label: a.label,
          packageName: a.packageName,
          icon: '' // No upload large blob
        })),
        whitelistedApps: [],
        lastFaceMatch: true,
        requestStop: false,
        requestPause: false,
        pausedByFace: false,
        isOnline: true
      };

      // Add self to buddyIds for discovery after cache clear
      const { arrayUnion } = await import('firebase/firestore');
      await updateDoc(doc(db, 'sessions', sessionCode), {
        buddyIds: arrayUnion(user.uid)
      });

      await setDoc(doc(db, 'sessions', sessionCode, 'buddies', user.uid), buddyData);
      setSession({ id: sessionCode, ...sessionSnap.data() } as Session);
      setBuddy({ id: user.uid, ...buddyData });
      
      localStorage.setItem('active_session_code', sessionCode);
      localStorage.setItem('active_role', 'BUDDY');

      console.log('Joined session successfully:', sessionCode);
    } catch (err) {
      const info = handleFirestoreError(err, OperationType.WRITE, `sessions/${sessionCode}/buddies/${user.uid}`);
      setError(`Failed to join session: ${info.error}`);
    }
    setJoining(false);
  };

  const [showFaceReg, setShowFaceReg] = useState(false);

  const handleBuddyExit = () => {
    if (session && (session.status === 'active' || session.status === 'paused')) {
      console.log("You cannot leave during an active focus session!");
      return;
    }
    localStorage.removeItem('active_role');
    localStorage.removeItem('active_session_code');
    setSession(null);
    setBuddy(null);
    onBack();
  };

  const registerFace = async (descriptor: string, faceSnapshot: string) => {
    if (!session || !buddy) return;
    setRegisteringFace(true);
    try {
      await updateDoc(doc(db, 'sessions', session.id, 'buddies', buddy.id), {
        faceImage: faceSnapshot,
        faceDescriptor: descriptor
      });
      console.log('Face registered successfully');
      setShowFaceReg(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}/buddies/${buddy.id}`);
    }
    setRegisteringFace(false);
  };

  if (session && buddy) {
    if (session.status === 'ended') {
      return (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[#FDFBF0] dark:bg-neutral-950">
          <div className="w-20 h-20 bg-red-500/10 rounded-[2rem] flex items-center justify-center mb-6 text-red-500 border border-red-500/20 shadow-xl shadow-red-500/10">
            <XCircle className="w-10 h-10" />
          </div>
          <h2 className="text-3xl font-black mb-4 tracking-tight">Session Ended</h2>
          <p className="text-neutral-500 mb-10 text-sm max-w-xs leading-relaxed font-medium capitalize">
            The session was ended by the admin or concluded normally.
          </p>
          <motion.button 
            whileTap={{ scale: 0.95 }}
            onClick={() => {
              localStorage.removeItem('active_session_code');
              localStorage.removeItem('active_role');
              setSession(null);
              setBuddy(null);
              onBack();
            }}
            className="bg-[#707A3E] text-white px-12 py-4 rounded-2xl font-black uppercase tracking-widest text-xs shadow-lg shadow-[#707A3E]/30 active:scale-95 transition-all"
          >
            Back to Home
          </motion.button>
        </div>
      );
    }

    if ((session.status === 'active' || session.status === 'paused') && buddy.status === 'approved') {
      if (!buddy.faceImage) {
        return (
          <div className="fixed inset-0 z-[150] bg-[#FDFBF0] dark:bg-neutral-950 flex flex-col items-center justify-center p-8 text-center">
            <div className="w-20 h-20 bg-yellow-500/10 rounded-[2rem] flex items-center justify-center mb-6 text-yellow-500 border border-yellow-500/20 shadow-xl shadow-yellow-500/10">
              <Camera className="w-10 h-10" />
            </div>
            <h2 className="text-3xl font-black mb-4 tracking-tight">Identity Required</h2>
            <p className="text-neutral-500 mb-10 text-sm max-w-xs leading-relaxed font-medium">
              You must register your face before starting the focus session. This is for your own security.
            </p>
            <motion.button 
              whileTap={{ scale: 0.95 }}
              onClick={() => setShowFaceReg(true)}
              className="bg-[#707A3E] text-white px-12 py-4 rounded-2xl font-black uppercase tracking-widest text-xs shadow-lg shadow-[#707A3E]/30 active:scale-95 transition-all w-full max-w-xs"
            >
              Register Now
            </motion.button>
            {showFaceReg && <FaceRegistration onComplete={registerFace} onCancel={() => setShowFaceReg(false)} />}
          </div>
        );
      }
      return <FocusMode session={session} buddy={buddy} />;
    }

    return (
      <div className="flex-1 flex flex-col overflow-hidden">
        <BlockingAlert />
        
        {localCountdown !== null && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="fixed inset-0 z-[300] bg-[#707A3E] flex flex-col items-center justify-center text-white"
          >
            <Clock className="w-20 h-20 mb-8 animate-pulse text-white/50" />
            <div className="text-[20px] font-black uppercase tracking-[0.5em] mb-4">Starting Mode</div>
            <div className="text-9xl font-black tracking-tighter">{localCountdown}</div>
            <div className="mt-8 text-center max-w-xs px-6 mb-8">
              <p className="text-white/60 text-xs font-bold uppercase tracking-[0.2em] animate-pulse">Starting Focus Mode</p>
              <p className="text-white/40 text-[10px] mt-2 font-medium">Session will be LOCKED in {localCountdown} seconds. No escape possible after this.</p>
            </div>
            
            {(localCountdown > 0) && (
              <motion.button
                whileTap={{ scale: 0.95 }}
                onClick={async () => {
                  if (buddy) {
                    await deleteDoc(doc(db, 'sessions', session.id, 'buddies', buddy.id));
                    localStorage.removeItem('active_session_code');
                    localStorage.removeItem('active_role');
                    setSession(null);
                    setBuddy(null);
                  }
                }}
                className="px-8 py-3 border border-white/20 hover:bg-white/5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all"
              >
                Leave Session
              </motion.button>
            )}
          </motion.div>
        )}

        <div className="flex items-center justify-between mb-8 flex-shrink-0">
          <motion.button 
            whileTap={{ scale: 0.9 }}
            onClick={async () => {
              if (buddy) {
                const conf = window.confirm("Are you sure you want to leave the lobby?");
                if (!conf) return;
                await deleteDoc(doc(db, 'sessions', session.id, 'buddies', buddy.id));
                localStorage.removeItem('active_session_code');
                localStorage.removeItem('active_role');
                setSession(null);
                setBuddy(null);
              }
            }} 
            className="p-2.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-xl shadow-sm"
          >
            <ArrowLeft className="w-5 h-5 text-[#707A3E]" />
          </motion.button>
          <div className="text-center">
            <h2 className="text-lg font-black tracking-tight">Buddy Lobby</h2>
            <div className="text-[8px] text-neutral-500 font-bold uppercase tracking-widest mt-0.5">Waiting for start</div>
          </div>
          <div className="w-10" />
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-6">
          <div className="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 p-6 rounded-[2rem] space-y-6 shadow-sm">
            <div className="p-4 bg-[#707A3E]/5 border border-[#707A3E]/10 rounded-2xl">
              <div className="text-[8px] text-[#707A3E] font-black uppercase tracking-widest mb-1">Device Status</div>
              <div className="text-[10px] text-neutral-500 dark:text-neutral-400 font-medium">Waiting for admin approval. Face registration is MANDATORY to proceed.</div>
            </div>

            <div>
              <div className="text-[8px] text-neutral-500 uppercase font-black tracking-widest mb-3">Your Status</div>
              <div className="flex items-center justify-between p-4 bg-neutral-50 dark:bg-neutral-800/50 rounded-2xl border border-neutral-200 dark:border-neutral-700">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-2 h-2 rounded-full",
                    buddy.status === 'approved' ? "bg-green-500" : "bg-yellow-500 animate-pulse"
                  )} />
                  <span className="text-xs font-bold uppercase tracking-wider">{buddy.status}</span>
                </div>
                {buddy.status === 'pending' && (
                  <span className="text-[10px] text-neutral-400 font-medium italic">Waiting for approval...</span>
                )}
              </div>
            </div>

            <div>
              <div className="text-[8px] text-neutral-500 uppercase font-black tracking-widest mb-3">Face Recognition</div>
              {buddy.faceImage ? (
                <div className="flex items-center gap-3 p-3 bg-green-500/10 border border-green-500/20 rounded-xl">
                  <div className="w-10 h-10 bg-green-500/20 rounded-xl flex items-center justify-center">
                    <UserCheck className="w-5 h-5 text-green-500" />
                  </div>
                  <div className="flex-1">
                    <div className="text-xs font-bold text-green-500 uppercase tracking-tighter">Biometric Profile Linked</div>
                    <div className="text-[9px] text-green-500/60 font-medium tracking-tight">On-device descriptor active</div>
                  </div>
                  <CheckCircle2 className="w-4 h-4 text-green-500" />
                </div>
              ) : (
                <motion.button 
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setShowFaceReg(true)}
                  className="w-full flex items-center justify-center gap-2 bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 py-3 rounded-xl text-xs font-black uppercase tracking-widest transition-all"
                >
                  <Camera className="w-4 h-4" /> Register Face
                </motion.button>
              )}
            </div>

            <div>
              <div className="text-[8px] text-neutral-500 uppercase font-black tracking-widest mb-3">Whitelisted Apps</div>
              <div className="flex flex-wrap gap-2">
                {/* Essential Apps */}
                {ESSENTIAL_APPS.slice(0, 3).map(app => (
                  <span key={app.packageName} className="bg-neutral-100 dark:bg-neutral-800/50 text-neutral-500 px-2.5 py-1 rounded-lg text-[10px] border border-neutral-200 dark:border-neutral-700 flex items-center gap-1 shadow-sm font-bold">
                    <ShieldCheck className="w-3 h-3" />
                    {app.label}
                  </span>
                ))}
                {/* Admin Whitelisted Apps */}
                {(buddy.whitelistedApps || []).map(pkg => {
                  const app = (buddy.installedApps || []).find(a => a.packageName === pkg);
                  if (ESSENTIAL_APPS.some(e => e.packageName === pkg)) return null;
                  return (
                    <span key={pkg} className="bg-[#707A3E]/10 text-[#707A3E] px-2.5 py-1 rounded-lg text-[10px] border border-[#707A3E]/20 font-black uppercase tracking-wider">
                      {app?.label || pkg}
                    </span>
                  );
                })}
              </div>
            </div>
          </div>

          <button 
            onClick={handleBuddyExit}
            className="w-full py-4 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors text-[10px] font-black uppercase tracking-[0.2em]"
          >
            Leave Session
          </button>
        </div>

        {showFaceReg && (
          <FaceRegistration 
            onComplete={registerFace} 
            onCancel={() => setShowFaceReg(false)} 
          />
        )}
      </div>
    );
  }

  return (
    <div className="max-w-md mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="flex items-center mb-8 sm:mb-12">
        <button onClick={onBack} className="p-2 hover:bg-neutral-200 dark:hover:bg-neutral-800 rounded-full transition-colors">
          <ArrowLeft className="w-6 h-6" />
        </button>
        <h2 className="text-xl sm:text-2xl font-bold ml-4">Join Session</h2>
      </div>

      <div className="space-y-4 sm:space-y-6">
        <div>
          <label className="text-[10px] sm:text-xs text-neutral-500 uppercase tracking-widest mb-2 block">Your Name</label>
          <input 
            type="text" 
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Enter your name..."
            className="w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl px-4 sm:px-6 py-3 sm:py-4 focus:outline-none focus:border-[#707A3E] transition-all text-sm sm:text-base shadow-sm"
          />
        </div>

        <div>
          <label className="text-[10px] sm:text-xs text-neutral-500 uppercase tracking-widest mb-2 block">6-Digit Code</label>
          <input 
            type="text" 
            maxLength={6}
            value={sessionCode}
            onChange={(e) => setSessionCode(e.target.value.replace(/\D/g, ''))}
            placeholder="000000"
            className="w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl px-4 sm:px-6 py-3 sm:py-4 text-center text-2xl sm:text-3xl font-mono font-bold tracking-[0.3em] sm:tracking-[0.5em] focus:outline-none focus:border-[#707A3E] transition-all placeholder:text-neutral-200 dark:placeholder:text-neutral-800 shadow-sm"
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 text-red-500 text-sm bg-red-500/10 p-4 rounded-2xl border border-red-500/20">
            <AlertCircle className="w-4 h-4" />
            {error}
          </div>
        )}

        <button 
          onClick={joinSession}
          disabled={joining}
          className="w-full bg-[#707A3E] hover:bg-[#555D2F] disabled:opacity-50 text-white py-4 rounded-2xl font-bold transition-all shadow-lg shadow-[#707A3E]/20"
        >
          {joining ? 'Connecting...' : 'Join Session'}
        </button>
      </div>
    </div>
  );
}

function FocusMode({ session, buddy }: { session: Session, buddy: Buddy }) {
  const [timeLeft, setTimeLeft] = useState(0);
  const isEnded = session.status === 'ended';
  const isPaused = session.status === 'paused';
  const isActive = session.status === 'active';
  const [screenOn, setScreenOn] = useState(true);
  const [appIcons, setAppIcons] = useState<Record<string, string>>({});
  const engineRef = useRef<FaceSecurityEngineRef>(null);
  const debounceTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [stopRequested, setStopRequested] = useState(buddy.requestStop || false);
  const [pauseRequested, setPauseRequested] = useState(buddy.requestPause || false);

  useEffect(() => {
    setStopRequested(buddy.requestStop || false);
    setPauseRequested(buddy.requestPause || false);
  }, [buddy.requestStop, buddy.requestPause]);

  useEffect(() => {
    const checkScreen = () => {
      if (window.Android && window.Android.isScreenOn) {
        setScreenOn(window.Android.isScreenOn());
      }
    };
    const interval = setInterval(checkScreen, 5000);
    return () => {
      clearInterval(interval);
      if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (window.Android && buddy.whitelistedApps) {
      window.Android.updateWhitelist(JSON.stringify(buddy.whitelistedApps), getSessionToken());
    }
  }, [buddy.whitelistedApps]);

  useEffect(() => {
    if (window.Android) {
      const token = getSessionToken();
      if (isActive && !buddy.pausedByFace) {
        window.Android.startFocusSession(JSON.stringify(buddy.whitelistedApps || []), session.id, buddy.id, token);
      } else {
        window.Android.stopFocusSession(token);
      }
    }
    return () => {
      if (window.Android) {
        window.Android.stopFocusSession(getSessionToken());
      }
    };
  }, [isActive, isPaused, isEnded, buddy.pausedByFace, session.id, buddy.id]);

  useEffect(() => {
    if (window.Android && window.Android.getAppIcon) {
      const neededIcons = [...(buddy.whitelistedApps || []), ...ESSENTIAL_APPS.map(e => e.packageName)];
      const newIcons: Record<string, string> = { ...appIcons };
      neededIcons.forEach(pkg => {
        if (!newIcons[pkg]) {
          const icon = window.Android!.getAppIcon(pkg);
          if (icon) newIcons[pkg] = icon.startsWith('data:') ? icon : `data:image/png;base64,${icon}`;
        }
      });
      setAppIcons(newIcons);
    }
  }, [buddy.whitelistedApps]);

  useEffect(() => {
    if (isEnded) { setTimeLeft(0); return; }
    let timer: NodeJS.Timeout;
    if ((session.status === 'active' || session.status === 'paused') && session.startTime) {
      const start = session.startTime.toDate ? session.startTime.toDate().getTime() : session.startTime;
      const checkAndSetTime = () => {
        const now = session.status === 'paused' && session.pausedAt
          ? (session.pausedAt.toDate ? session.pausedAt.toDate().getTime() : session.pausedAt)
          : Date.now();
        const elapsed = Math.floor((now - start) / 1000);
        const pausedSeconds = session.accumulatedPausedSeconds || 0;
        const remaining = Math.max(0, session.timerSeconds - elapsed + pausedSeconds);
        setTimeLeft(remaining);
        
        if (remaining <= 0) {
          if (timer) clearInterval(timer);
          // AUTO END SESSION FROM BUDDY SIDE (safeguard)
          if (window.Android && window.Android.stopFocusSession) {
            window.Android.stopFocusSession(getSessionToken());
          }
          updateDoc(doc(db, 'sessions', session.id), {
            status: 'ended',
            focusActive: false,
            endedAt: serverTimestamp()
          }).then(() => {
            console.log('Session auto-ended after reaching 0:00 (Buddy side)');
          }).catch(err => {
            console.error('Failed to auto-end session from Buddy side:', err);
          });
          return true;
        }
        return false;
      };

      const ended = checkAndSetTime();
      if (!ended && session.status === 'active') {
        timer = setInterval(checkAndSetTime, 1000);
      }
    }
    return () => clearInterval(timer);
  }, [session.status, session.startTime, session.timerSeconds, session.pausedAt, session.accumulatedPausedSeconds, isEnded]);

  const updateVerification = (isLocked: boolean, isPaused: boolean, securityAlert?: string | null) => {
    if (debounceTimeoutRef.current) clearTimeout(debounceTimeoutRef.current);
    debounceTimeoutRef.current = setTimeout(async () => {
      try {
        const updates: any = {
          pausedByFace: isPaused,
          lastFaceMatch: isLocked
        };
        if (securityAlert !== undefined) {
          updates.securityAlert = securityAlert;
        } else {
          // Clear security alert if returning to normal verified state
          if (isLocked && !isPaused && buddy.securityAlert === 'SUSPECTED_SPOOF') {
            updates.securityAlert = null;
          }
        }
        await updateDoc(doc(db, 'sessions', session.id, 'buddies', buddy.id), updates);
      } catch (e) { console.error("Sync error:", e); }
    }, 1000);
  };

  const whitelistedAppInfos = [...ESSENTIAL_APPS, ...(buddy.installedApps || []).filter(app => 
    (buddy.whitelistedApps || []).includes(app.packageName) &&
    !ESSENTIAL_APPS.some(e => e.packageName === app.packageName)
  )];

  const launchApp = (packageName: string) => {
    if (window.Android && window.Android.launchApp) {
      window.Android.launchApp(packageName, getSessionToken());
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[100] bg-[#FDFBF0] dark:bg-neutral-950 flex flex-col p-6 text-center overflow-hidden selection:bg-[#707A3E]/30"
    >
      {/* Invisible Secure Verification Engine */}
      <FaceSecurityEngine 
        ref={engineRef}
        isSessionActive={isActive && !isEnded && !isPaused}
        storedDescriptor={buddy.faceDescriptor || undefined}
        ghostMode={true}
        showHUD={false}
        onBuddyLocked={() => updateVerification(true, false, null)}
        onStrangerPaused={() => updateVerification(false, true)}
        onBuddyReturned={() => updateVerification(true, false, null)}
        onCameraBlocked={() => updateVerification(true, false)} // Anti-escape
        onSuspectedSpoof={() => updateVerification(false, false, 'SUSPECTED_SPOOF')}
      />
      
      {/* Immersive background for Focus Mode */}
      <div className="fixed inset-0 opacity-[0.01] pointer-events-none dark:opacity-[0.03]" style={{ backgroundImage: `radial-gradient(#707A3E 1px, transparent 1px)`, backgroundSize: '40px 40px' }} />
      
      {(!screenOn || (buddy.pausedByFace && !isEnded) || buddy.securityAlert === 'SUSPECTED_SPOOF') && (
        <div className="absolute inset-0 z-[110] bg-white/95 dark:bg-neutral-950/95 backdrop-blur-xl flex flex-col items-center justify-center p-8 text-center">
          <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className={cn(
              "w-20 h-20 rounded-[1.5rem] flex items-center justify-center mb-6 border shadow-2xl",
              buddy.securityAlert === 'SUSPECTED_SPOOF' 
                ? "bg-red-500/20 border-red-500/30 shadow-red-500/20" 
                : "bg-yellow-500/20 border-yellow-500/30 shadow-yellow-500/20"
            )}
          >
            {buddy.securityAlert === 'SUSPECTED_SPOOF' ? (
              <AlertCircle className="w-10 h-10 text-red-500" />
            ) : (
              <UserX className="w-10 h-10 text-yellow-500" />
            )}
          </motion.div>
          <h3 className="text-2xl font-black text-neutral-900 dark:text-white mb-3 tracking-tight">
            {buddy.securityAlert === 'SUSPECTED_SPOOF' ? 'Security Lock' : 'Stranger Detected'}
          </h3>
          <p className="text-neutral-500 dark:text-neutral-400 text-sm max-w-xs leading-relaxed">
            {buddy.securityAlert === 'SUSPECTED_SPOOF' 
              ? 'Liveness verification failed. Active spoofing suspected.' 
              : 'Focus mode is temporarily paused because a stranger was detected.'}
          </p>
          <div className="mt-8 flex flex-col items-center gap-3">
            <div className={cn(
              "w-6 h-6 border-2 rounded-full animate-spin",
              buddy.securityAlert === 'SUSPECTED_SPOOF' 
                ? "border-red-500/20 border-t-red-500" 
                : "border-yellow-500/20 border-t-yellow-500"
            )} />
            <div className={cn(
              "text-[8px] font-black uppercase tracking-[0.4em]",
              buddy.securityAlert === 'SUSPECTED_SPOOF' ? "text-red-500" : "text-yellow-500"
            )}>
              {buddy.securityAlert === 'SUSPECTED_SPOOF' ? 'Performing Liveness Challenge' : 'Waiting for Buddy'}
            </div>
          </div>
        </div>
      )}

      {isPaused && !buddy.pausedByFace && !isEnded && (
        <div className="absolute inset-0 z-[115] bg-white/95 dark:bg-neutral-950/95 backdrop-blur-xl flex flex-col items-center justify-center p-8 text-center">
          <motion.div 
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="w-20 h-20 bg-[#707A3E]/10 rounded-[1.5rem] flex items-center justify-center mb-6 border border-[#707A3E]/20 shadow-2xl shadow-[#707A3E]/10"
          >
            <Pause className="w-10 h-10 text-[#707A3E]" />
          </motion.div>
          <h3 className="text-2xl font-black text-neutral-900 dark:text-white mb-3 tracking-tight">Session Paused</h3>
          <p className="text-[#707A3E] font-bold mb-4">Admin paused the session.</p>
          <p className="text-neutral-500 dark:text-neutral-400 text-sm max-w-xs leading-relaxed">
            You are free to use your device now. Focus mode will automatically resume when the admin restarts it.
          </p>
          <div className="mt-8 flex flex-col items-center gap-3">
            <div className="flex gap-2">
              <div className="w-2 h-2 rounded-full bg-[#707A3E] animate-bounce [animation-delay:-0.3s]" />
              <div className="w-2 h-2 rounded-full bg-[#707A3E] animate-bounce [animation-delay:-0.15s]" />
              <div className="w-2 h-2 rounded-full bg-[#707A3E] animate-bounce" />
            </div>
          </div>
        </div>
      )}

      {isEnded ? (
        <motion.div 
          initial={{ scale: 0.9, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="flex-1 flex flex-col items-center justify-center space-y-6"
        >
          <div className="w-20 h-20 bg-gradient-to-br from-green-500 to-green-600 rounded-[1.5rem] flex items-center justify-center mx-auto mb-6 shadow-2xl shadow-green-500/30">
            <Check className="w-10 h-10 text-white" />
          </div>
          <h2 className="text-3xl font-black text-neutral-900 dark:text-white tracking-tight">Congrats!</h2>
          <p className="text-neutral-500 dark:text-neutral-400 text-base font-medium">The session has concluded successfully.</p>
          <div className="text-6xl font-mono font-black text-neutral-100 dark:text-neutral-900 tracking-tighter">00:00</div>
          <motion.button 
            whileTap={{ scale: 0.95 }}
            onClick={() => window.location.reload()}
            className="mt-8 px-10 py-3.5 bg-[#707A3E] text-white rounded-2xl font-black uppercase tracking-widest text-[10px] transition-all shadow-lg shadow-[#707A3E]/20"
          >
            Exit Focus Mode
          </motion.button>
        </motion.div>
      ) : (
        <>
          <div className="flex items-center justify-between mb-8 relative z-10 flex-shrink-0">
            <div className="flex items-center gap-2 text-[#707A3E] bg-[#707A3E]/10 px-4 py-2 rounded-full border border-[#707A3E]/20">
              <Lock className="w-4 h-4" />
              <span className="text-[8px] font-black uppercase tracking-[0.2em]">Focus Mode Active</span>
            </div>
            <div className="text-2xl font-mono font-black text-neutral-900 dark:text-white tabular-nums tracking-tight">
              {formatTime(timeLeft)}
            </div>
          </div>

          <div className="flex-1 flex flex-col overflow-hidden">
            <div className="text-neutral-500 text-[8px] uppercase tracking-[0.2em] mb-4 text-left font-black flex-shrink-0">Whitelisted Apps</div>
            
            <div className="flex-1 overflow-y-auto custom-scrollbar pr-1">
              <div className="grid grid-cols-3 gap-4 pb-4">
                {whitelistedAppInfos.map(app => (
                  <motion.button
                    key={app.packageName}
                    whileTap={{ scale: 0.9 }}
                    onClick={() => launchApp(app.packageName)}
                    className="flex flex-col items-center gap-2 group"
                  >
                    <div className="w-14 h-14 bg-white dark:bg-neutral-900 rounded-2xl flex items-center justify-center overflow-hidden border border-neutral-200 dark:border-neutral-800 shadow-sm group-hover:shadow-[#707A3E]/10 transition-shadow">
                      {appIcons[app.packageName] ? (
                        <img 
                          src={appIcons[app.packageName]} 
                          alt={app.label} 
                          className="w-full h-full object-cover"
                          referrerPolicy="no-referrer"
                        />
                      ) : (
                        <Smartphone className="w-6 h-6 text-neutral-400" />
                      )}
                    </div>
                    <span className="text-[9px] font-bold text-neutral-500 truncate w-full px-1">
                      {app.label}
                    </span>
                  </motion.button>
                ))}
                
                {whitelistedAppInfos.length === 0 && (
                  <div className="col-span-full py-8 text-center text-neutral-400 border-2 border-dashed border-neutral-100 dark:border-neutral-900 rounded-2xl text-[10px] font-bold uppercase tracking-widest">
                    No apps whitelisted
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mt-6 space-y-4 flex-shrink-0">
            <div className="grid grid-cols-2 gap-3">
              <motion.button 
                whileTap={{ scale: 0.95 }}
                disabled={stopRequested}
                onClick={async () => {
                  try {
                    setStopRequested(true);
                    await updateDoc(doc(db, 'sessions', session.id, 'buddies', buddy.id), { requestStop: true });
                  } catch (err) {
                    setStopRequested(buddy.requestStop || false);
                    handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}/buddies/${buddy.id}`);
                  }
                }}
                className={cn(
                  "py-3.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl text-red-500 hover:bg-red-50 transition-colors text-[9px] font-black uppercase tracking-widest shadow-sm",
                  stopRequested && "opacity-50 cursor-not-allowed"
                )}
              >
                {stopRequested ? '✓ Stop Requested' : 'Request Stop'}
              </motion.button>
              <motion.button 
                whileTap={{ scale: 0.95 }}
                disabled={pauseRequested}
                onClick={async () => {
                  try {
                    setPauseRequested(true);
                    await updateDoc(doc(db, 'sessions', session.id, 'buddies', buddy.id), { requestPause: true });
                  } catch (err) {
                    setPauseRequested(buddy.requestPause || false);
                    handleFirestoreError(err, OperationType.UPDATE, `sessions/${session.id}/buddies/${buddy.id}`);
                  }
                }}
                className={cn(
                  "py-3.5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-2xl text-yellow-600 hover:bg-yellow-50 transition-colors text-[9px] font-black uppercase tracking-widest shadow-sm",
                  pauseRequested && "opacity-50 cursor-not-allowed"
                )}
              >
                {pauseRequested ? '✓ Pause Requested' : 'Request Pause'}
              </motion.button>
            </div>
            
            <div className="text-neutral-400 text-[7px] uppercase tracking-[0.5em] font-black opacity-50">
              Strict Anti-Exit Protection Enabled
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
}
