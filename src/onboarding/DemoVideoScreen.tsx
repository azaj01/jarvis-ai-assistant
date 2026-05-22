import React, { useState } from 'react';
import YouTubeEmbed from '../components/YouTubeEmbed';
import { theme } from '../styles/theme';

interface DemoVideoScreenProps {
  onNext: () => void;
}

const DemoVideoScreen: React.FC<DemoVideoScreenProps> = ({ onNext }) => {
  const [hasWatched, setHasWatched] = useState(false);
  const videoId = 'TnNf300Bbxg';

  const handleVideoStart = () => {
    setHasWatched(true);
  };

  return (
    <div className="w-full max-w-4xl mx-auto px-6 text-center">
      {/* Header */}
      <div className="mt-8 mb-12">
        <h1 className="text-2xl font-medium text-white mb-3">
          See Jarvis in Action
        </h1>
        <p className="text-white/70 max-w-md mx-auto">
          Quick 2-minute demo showing how Jarvis works
        </p>
      </div>

      {/* Video Container */}
      <div className="relative mb-8">
        <div style={{ minHeight: '400px' }}>
          <YouTubeEmbed
            videoId={videoId}
            title="Jarvis Demo"
            onVideoStart={handleVideoStart}
            className="w-full"
          />
        </div>
      </div>

      {/* Watched indicator */}
      {hasWatched && (
        <div className="text-center text-sm text-green-400 mb-4">
          ✓ Demo started - you can continue below
        </div>
      )}
    </div>
  );
};

export default DemoVideoScreen;
