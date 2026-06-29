import pageTurnerLogo from '../assets/page-turner-logo.svg';

type ErrorPageProps = {
  error?: {
    title?: string;
    message?: string;
    details?: string;
  };
  onRetry?: () => void;
  onGoHome?: () => void;
};

export function ErrorPage({
  error = {
    title: 'Something went wrong',
    message: 'We encountered an unexpected error. Please try again.',
  },
  onRetry,
  onGoHome,
}: ErrorPageProps) {
  return (
    <div className="flex-1 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        {/* Logo and Brand */}
        <div className="text-center">
          <div className="flex items-center justify-center mb-6">
            <img src={pageTurnerLogo} alt="PageTurner" className="h-12" />
          </div>
        </div>

        {/* Error Content */}
        <div className="text-center space-y-6">
          <div className="flex justify-center">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center">
              <svg
                className="w-8 h-8 text-red-600"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
          </div>

          <div className="space-y-3">
            <h2 className="text-2xl font-semibold text-gray-900">
              {error.title}
            </h2>
            <p className="text-gray-600 max-w-sm mx-auto">{error.message}</p>
            {error.details && (
              <details className="text-left">
                <summary className="text-sm text-gray-500 cursor-pointer hover:text-gray-700">
                  Show technical details
                </summary>
                <pre className="mt-2 text-xs text-gray-600 bg-gray-50 p-3 rounded border overflow-x-auto">
                  {error.details}
                </pre>
              </details>
            )}
          </div>

          {/* Action Buttons */}
          <div className="space-y-3">
            {onRetry && (
              <button
                onClick={onRetry}
                className="w-full bg-blue-600 text-white px-4 py-3 rounded-lg font-medium hover:bg-blue-700 transition-colors flex items-center justify-center gap-2"
              >
                <svg
                  className="w-4 h-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                    clipRule="evenodd"
                  />
                </svg>
                Try Again
              </button>
            )}

            {onGoHome && (
              <button
                onClick={onGoHome}
                className="w-full bg-gray-100 text-gray-700 px-4 py-3 rounded-lg font-medium hover:bg-gray-200 transition-colors"
              >
                Go Home
              </button>
            )}
          </div>

          {/* Support Info */}
          <div className="text-center border-t pt-6">
            <p className="text-sm text-gray-600">
              Need help?{' '}
              <a href="#" className="text-blue-600 hover:text-blue-500">
                Contact Support
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
