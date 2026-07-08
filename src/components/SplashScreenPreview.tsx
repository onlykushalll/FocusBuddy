import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Shield, Check, Loader2, XCircle } from 'lucide-react';

export default function SplashScreenPreview({ 
  onComplete,
  authReady,
  modelsReady,
  connectionError
}: { 
  onComplete: () => void;
  authReady: boolean;
  modelsReady: boolean;
  connectionError: string | null;
}) {
  const [animationMinTimePassed, setAnimationMinTimePassed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setAnimationMinTimePassed(true);
    }, 5000); // 5 second gap exactly
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const isAuthDone = authReady || connectionError !== null;
    if (animationMinTimePassed && modelsReady && isAuthDone) {
      onComplete();
    }
  }, [animationMinTimePassed, modelsReady, authReady, connectionError, onComplete]);

  return (
    <div className="fixed inset-0 z-[500] bg-[#FDFBF0] dark:bg-neutral-950 flex flex-col items-center justify-center overflow-hidden font-sans">
      {/* Background subtle pattern */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none dark:opacity-[0.05]" style={{ backgroundImage: `radial-gradient(#707A3E 1px, transparent 1px)`, backgroundSize: '24px 24px' }} />
      
      <div className="relative flex flex-col items-center justify-center w-full h-full">
        {/* Logo Icon */}
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", damping: 12, stiffness: 100 }}
          className="w-24 h-24 bg-gradient-to-br from-[#707A3E] to-[#555D2F] rounded-3xl flex items-center justify-center mb-8 shadow-2xl shadow-[#707A3E]/40"
        >
          <Shield className="w-12 h-12 text-white" />
        </motion.div>

        {/* App Name */}
        <motion.h1 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.8 }}
          className="text-4xl font-black text-[#707A3E] dark:text-[#E1E8C1] tracking-tighter mb-4"
        >
          AdultFocusBuddy
        </motion.h1>
        
        <motion.p 
          initial={{ opacity: 0 }}
          animate={{ opacity: 0.6 }}
          transition={{ delay: 0.8, duration: 0.8 }}
          className="text-lg font-medium text-[#555D2F] dark:text-[#707A3E] italic mb-24"
        >
          "Focus karle Buddy"
        </motion.p>

        {/* Loading Indicator at ~6/8 position (25% from bottom) */}
        <div className="absolute bottom-[20%] flex flex-col items-center gap-6">
          <div className="relative">
            <div className="w-12 h-12 border-4 border-[#707A3E]/10 rounded-full" />
            <div className="absolute inset-0 w-12 h-12 border-4 border-transparent border-t-[#707A3E] rounded-full animate-spin" />
          </div>
          <span className="text-xs font-black text-[#707A3E]/40 tracking-[0.5em] uppercase">
            Loading
          </span>
        </div>
      </div>
    </div>
  );
}

