import { useState, useEffect } from 'react';
import type { Book } from '../modules/DataTransformSchema';
import LoadingAnimation from '../components/LoadingAnimation';
import brandLogo from '../assets/brand-logo.svg';
import { GoodreadsConnectionModal } from '../components/GoodreadsConnectionModal';

type LoadingPageProps = {
  initialStep?: number;
  totalSteps?: number;
  autoComplete?: boolean;
  onComplete?: () => void;
  stepDurations?: number[];
  onSuccessConnect: (data: Book[]) => void;
  onConnectionError?: (errorDetails: string) => void;
  onProgressStep?: (step: number) => void;
  onAuthComplete?: () => void;
};

export function LoadingPage({
  initialStep = 1,
  totalSteps = 5,
  autoComplete = true,
  onComplete,
  stepDurations = [2000, 3000, 2500, 1000], // Duration for each step in milliseconds
  onSuccessConnect,
  onConnectionError,
  onProgressStep,
  onAuthComplete,
}: LoadingPageProps) {
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [progress, setProgress] = useState((initialStep / totalSteps) * 100);

  // Update currentStep when initialStep changes (external control)
  useEffect(() => {
    setCurrentStep(initialStep);
  }, [initialStep]);

  const steps = [
    { number: 1, label: 'Connect' },
    { number: 2, label: 'Sign in' },
    { number: 3, label: 'Extract' },
    { number: 4, label: 'Load' },
    { number: 5, label: 'Complete' },
  ];

  useEffect(() => {
    const progressInterval = setInterval(() => {
      const targetProgress = (currentStep / totalSteps) * 100;
      setProgress((prev) => {
        const diff = targetProgress - prev;
        if (Math.abs(diff) > 1) {
          return prev + diff * 0.1;
        }
        return targetProgress;
      });
    }, 50);

    let stepTimeout: NodeJS.Timeout | undefined;

    // Auto-advance to next step only if autoComplete is true AND we're not being externally controlled
    if (autoComplete && currentStep < totalSteps) {
      const duration = stepDurations[currentStep - 1] || 2000;
      stepTimeout = setTimeout(() => {
        setCurrentStep((prev) => prev + 1);
      }, duration);
    } else if (autoComplete && currentStep === totalSteps && onComplete) {
      // Call onComplete after reaching the final step (only if auto-completing)
      stepTimeout = setTimeout(() => {
        onComplete();
      }, 1500);
    }

    return () => {
      if (progressInterval) clearInterval(progressInterval);
      if (stepTimeout) clearTimeout(stepTimeout);
    };
  }, [currentStep, totalSteps, autoComplete, onComplete, stepDurations]);

  const getStepStatus = (stepNumber: number) => {
    if (stepNumber < currentStep) return 'completed';
    if (stepNumber === currentStep) return 'active';
    return 'pending';
  };

  const getStepMessage = () => {
    switch (currentStep) {
      case 1:
        return 'Connecting to Goodreads...';
      case 2:
        return 'Please sign in to Goodreads...';
      case 3:
        return 'Extracting your Goodreads data...';
      case 4:
        return 'Loading book history...';
      case 5:
        return 'Almost done...';
      default:
        return 'Loading...';
    }
  };

  return (
    <div className="min-h-screen">
      {/* Main Content */}
      <div className="flex items-center justify-center min-h-[80vh]">
        <div className="max-w-md w-full text-center space-y-8 px-6">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 mb-4">
              Linking Your Account
            </h1>
            <p className="text-gray-600">
              Please wait while we connect to Goodreads and retrieve your
              information
            </p>
          </div>

          <div className="flex justify-center mb-8">
            <LoadingAnimation logoUrl={brandLogo} />
          </div>

          <div className="space-y-6">
            <p className="text-lg font-medium text-gray-900">
              {getStepMessage()}
            </p>

            {/* Progress Bar */}
            <div className="w-full">
              <div className="w-full bg-gray-200 rounded-full h-3">
                <div
                  className="bg-blue-600 h-3 rounded-full transition-all duration-200 ease-out"
                  style={{ width: `${progress}%` }}
                ></div>
              </div>
            </div>

            {/* Step Indicators */}
            <div className="flex justify-between items-center">
              {steps.map((step) => {
                const status = getStepStatus(step.number);
                return (
                  <div key={step.number} className="flex flex-col items-center">
                    <div
                      className={`w-10 h-10 rounded-full flex items-center justify-center text-sm font-medium border-2 transition-all duration-300 ${
                        status === 'completed' || status === 'active'
                          ? 'bg-blue-600 text-white border-blue-600'
                          : 'bg-gray-100 text-gray-500 border-gray-300'
                      } ${
                        status === 'active'
                          ? 'ring-2 ring-blue-200 ring-offset-2'
                          : ''
                      }`}
                    >
                      {status === 'completed' ? (
                        <svg
                          className="w-5 h-5"
                          fill="currentColor"
                          viewBox="0 0 20 20"
                        >
                          <path
                            fillRule="evenodd"
                            d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                            clipRule="evenodd"
                          />
                        </svg>
                      ) : (
                        step.number
                      )}
                    </div>
                    <span
                      className={`mt-2 text-sm font-medium transition-colors duration-300 ${
                        status === 'completed' || status === 'active'
                          ? 'text-blue-600'
                          : 'text-gray-500'
                      }`}
                    >
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className={`mt-4 ${currentStep === 2 ? '' : 'hidden'}`}>
              <GoodreadsConnectionModal
                onSuccessConnect={onSuccessConnect}
                onConnectionError={onConnectionError}
                onProgressStep={onProgressStep}
                onAuthComplete={onAuthComplete}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
