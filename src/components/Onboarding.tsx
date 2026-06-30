import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Shield, Smartphone, Users, CheckCircle2, ArrowRight } from 'lucide-react';

const LOGO_COLOR = "#707A3E";
const ACCENT_COLOR = "#E1E8C1";

interface OnboardingStep {
  title: string;
  description: string;
  icon: React.ReactNode;
  color: string;
}

const STEPS: OnboardingStep[] = [
  {
    title: "Zen Mode",
    description: "Lock your device into a distraction-free state. Only essential apps allowed while you focus.",
    icon: <Shield className="w-12 h-12" />,
    color: "#707A3E"
  },
  {
    title: "Buddy Pairing",
    description: "Connect with a buddy who monitors your session. They ensure you stay on task from their own device.",
    icon: <Users className="w-12 h-12" />,
    color: "#D97706"
  },
  {
    title: "Face Verification",
    description: "Our verification engine ensures it's you. If only a stranger is detected, focus mode pauses automatically. If you're alone or the camera is blocked, it stays locked.",
    icon: <Smartphone className="w-12 h-12" />,
    color: "#0284C7"
  }
];

export default function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [currentStep, setCurrentStep] = useState(0);

  const next = () => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      onComplete();
    }
  };

  return (
    <div className="fixed inset-0 z-[400] bg-[#FDFBF0] dark:bg-neutral-950 flex flex-col items-center justify-center p-6 overflow-hidden font-sans">
      <AnimatePresence mode="wait">
        <motion.div
          key={currentStep}
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -50 }}
          className="flex flex-col items-center text-center max-w-sm"
        >
          <div 
            className="w-24 h-24 rounded-3xl flex items-center justify-center mb-8 shadow-2xl"
            style={{ backgroundColor: `${STEPS[currentStep].color}20`, color: STEPS[currentStep].color }}
          >
            {STEPS[currentStep].icon}
          </div>
          
          <h2 className="text-3xl font-black mb-4 dark:text-white" style={{ color: STEPS[currentStep].color }}>
            {STEPS[currentStep].title}
          </h2>
          
          <p className="text-neutral-600 dark:text-neutral-400 leading-relaxed mb-12">
            {STEPS[currentStep].description}
          </p>
        </motion.div>
      </AnimatePresence>

      {/* Progress Dots */}
      <div className="flex gap-2 mb-12">
        {STEPS.map((_, i) => (
          <div 
            key={i}
            className={`h-1.5 rounded-full transition-all duration-300 ${i === currentStep ? 'w-8' : 'w-2'}`}
            style={{ backgroundColor: i === currentStep ? STEPS[currentStep].color : '#E5E5E5' }}
          />
        ))}
      </div>

      <button 
        onClick={next}
        className="w-full max-w-xs py-4 rounded-2xl font-bold text-white shadow-lg transition-all flex items-center justify-center gap-2"
        style={{ backgroundColor: STEPS[currentStep].color }}
      >
        {currentStep === STEPS.length - 1 ? "Get Started" : "Next"}
        <ArrowRight className="w-5 h-5" />
      </button>
    </div>
  );
}
