import { DataSource } from '../components/DataSource';
import goodreads from '../config/goodreads.json';
import type { BrandConfig } from '../modules/Config';
import pageTurnerLogo from '../assets/page-turner-logo.svg';

const goodreadsConfig = goodreads as BrandConfig;
const BRANDS: Array<BrandConfig> = [goodreadsConfig];

type OnboardingPageProps = {
  onConnectStart?: () => void;
  isConnecting?: boolean;
};

export function OnboardingPage({
  onConnectStart,
  isConnecting,
}: OnboardingPageProps) {
  return (
    <div className="flex-1 flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        {/* Logo and Title */}
        <div className="text-center">
          <div className="flex items-center justify-center mb-6">
            <img src={pageTurnerLogo} alt="PageTurner" className="h-12" />
          </div>

          <h2 className="text-2xl font-semibold text-gray-900 mb-2">
            Connect Your Goodreads
          </h2>
          <p className="text-gray-600 text-center max-w-sm mx-auto">
            Get $50 store credit and exclusive personalized perks at PageTurner
            when you link your Goodreads Account!
          </p>
        </div>

        {/* Goodreads Connection */}
        <div className="space-y-6">
          <DataSource
            key={BRANDS[0].brand_id}
            brandConfig={BRANDS[0]}
            onConnectStart={onConnectStart}
            disabled={isConnecting}
          />

          <div className="text-center">
            <p className="text-sm text-gray-600">
              By linking your account, you agree to our{' '}
              <a href="#" className="text-blue-600 hover:text-blue-500">
                Terms of Service
              </a>{' '}
              and{' '}
              <a href="#" className="text-blue-600 hover:text-blue-500">
                Privacy Policy
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
