import React, { useEffect } from 'react';
import confetti from 'canvas-confetti';
import { theme, themeComponents } from '../styles/theme';

interface PostOnboardingPromptProps {
  userName?: string;
  onDismiss: () => void;
}

const PostOnboardingPrompt: React.FC<PostOnboardingPromptProps> = ({ userName = 'there', onDismiss }) => {
  useEffect(() => {
    try {
      confetti({
        particleCount: 100,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#60a5fa', '#06b6d4', '#10b981', '#f59e0b']
      });
    } catch (err) {
      console.log('Confetti unavailable');
    }

    const api = (window as any).electronAPI;
    api?.posthogCapture?.('onboarding_completed', {});

    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className={`min-h-screen ${themeComponents.container} font-['Inter',-apple-system,BlinkMacSystemFont,'SF_Pro_Display','SF_Pro_Text',system-ui,sans-serif]`}>
      <div className="h-screen flex items-center justify-center py-4 px-6">
        <div className="w-full max-w-2xl text-center">
          <div className={`w-20 h-20 ${theme.glass.primary} ${theme.radius.xl} flex items-center justify-center mx-auto mb-8 ${theme.shadow}`}>
            <svg className="w-10 h-10 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h1 className={`text-4xl font-semibold ${theme.text.primary} mb-3`}>
            Jarvis is ready to use
          </h1>
          <p className={`text-lg ${theme.text.secondary} max-w-md mx-auto font-normal leading-relaxed`}>
            Hold Fn to dictate anytime.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PostOnboardingPrompt;
