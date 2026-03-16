import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrandConfig } from '../modules/Config';
import { transformData, type Book } from '../modules/DataTransformSchema';
import { apiClient } from '../api';
import * as Sentry from '@sentry/react';
import Modal from './Modal';

interface DataSourceProps {
  onSuccessConnect: (data: Book[]) => void;
  onConnectStart?: () => void;
  onConnectionError?: (errorDetails: string) => void;
  onProgressStep?: (step: number) => void;
  disabled?: boolean;
  brandConfig: BrandConfig;
  isConnected?: boolean;
  onAuthComplete?: () => void;
  onRetryConnection?: (url?: string) => void;
  signinUrl?: string;
}

export function DataSource({
  onSuccessConnect,
  onConnectStart,
  onConnectionError,
  onProgressStep,
  disabled,
  brandConfig,
  isConnected,
  onAuthComplete,
  onRetryConnection,
  signinUrl: signinUrlProp,
}: DataSourceProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [signinUiUrl, setSigninUiUrl] = useState<string | undefined>();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [initialToolResult, setInitialToolResult] = useState<unknown>();

  const startAuthentication = useCallback(
    async (signinId?: string) => {
      if (!signinId) {
        throw new Error('No Signin ID received');
      }

      try {
        let pollResult;
        while (true) {
          try {
            pollResult = await apiClient.pollSignin(signinId);
            console.log('Poll result:', pollResult);
            if (pollResult?.status === 'SUCCESS') break;
          } catch (error) {
            console.error('Poll auth error:', error);
            Sentry.captureException(error, {
              tags: {
                component: 'DataSource',
                brand_id: brandConfig.brand_id,
                brand_name: brandConfig.brand_name,
              },
            });
          }
        }

        // Transform and send success data
        const transformedData = transformData(
          pollResult,
          brandConfig.dataTransform
        );
        console.log('Transformed data:', transformedData);

        onAuthComplete?.();
        onProgressStep?.(3);
        setIsSubmitting(false);
        onSuccessConnect(transformedData as unknown as Book[]);
        apiClient.finalizeSignin(signinId);
      } catch (error) {
        console.error('Connection error:', error);
        Sentry.captureException(error, {
          tags: {
            component: 'DataSource',
            brand_id: brandConfig.brand_id,
            brand_name: brandConfig.brand_name,
          },
          extra: { brandConfig },
        });
        setIsSubmitting(false);
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown connection error';
        onConnectionError?.(errorMessage);
      }
    },
    [
      brandConfig,
      onAuthComplete,
      onConnectStart,
      onConnectionError,
      onProgressStep,
      onSuccessConnect,
    ]
  );

  useEffect(() => {
    if (!signinUiUrl || !initialToolResult) {
      return;
    }

    const iframe = iframeRef.current;
    if (!iframe) {
      return;
    }

    const onLoad = () => {
      try {
        iframe.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: initialToolResult,
          },
          '*'
        );
      } catch (error) {
        console.error('Failed to post tool-result message to iframe', error);
      }
    };

    iframe.addEventListener('load', onLoad);

    return () => {
      iframe.removeEventListener('load', onLoad);
    };
  }, [signinUiUrl, initialToolResult]);

  const isFormDisabled = disabled || isSubmitting;

  return (
    <>
      <div className="bg-white p-6 rounded-xl border border-gray-200 hover:border-gray-300 transition-colors">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8">
              <img
                src={brandConfig.logo_url}
                alt={`${brandConfig.brand_name} logo`}
                className="w-full h-full object-contain"
              />
            </div>
            <div>
              <h3 className="font-medium">{brandConfig.brand_name}</h3>
            </div>
          </div>
          {isConnected ? (
            <div className="px-4 py-2 flex items-center gap-2">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth="1.5"
                stroke="currentColor"
                className="size-4 text-green-700"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="m4.5 12.75 6 6 9-13.5"
                />
              </svg>

              <span className="text-green-700 text-sm font-medium">
                Connected
              </span>
            </div>
          ) : (
            <button
              disabled={disabled}
              onClick={async () => {
                if (isFormDisabled) {
                  return;
                }
                setIsSubmitting(true);
                try {
                  const response = await apiClient.getBookList();

                  setInitialToolResult(response.tool_result);

                  const iframeUrl = response.ui_resource_uri
                    ? `/api/mcp-apps/ui?resourceUri=${encodeURIComponent(
                        response.ui_resource_uri
                      )}`
                    : response.url;
                  setSigninUiUrl(iframeUrl);
                  setIsModalOpen(true);
                  startAuthentication(response.signin_id);
                } catch (error) {
                  console.error('Failed to start Goodreads signin UI:', error);
                  onConnectionError?.(
                    error instanceof Error
                      ? error.message
                      : 'Failed to start Goodreads signin UI'
                  );
                  setIsSubmitting(false);
                }
              }}
              className={`px-4 py-2 bg-black text-white text-sm font-medium rounded-lg hover:bg-gray-800 transition-colors ${
                disabled || isConnected ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              Connect
            </button>
          )}
        </div>
      </div>
      <Modal
        title={
          <div className="flex items-center gap-3">
            <img
              src={brandConfig.logo_url}
              alt={`${brandConfig.brand_name} logo`}
              className="w-8 h-8 object-contain"
            />
            <h3 className="font-medium">{brandConfig.brand_name}</h3>
          </div>
        }
        open={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
        }}
      >
        {!!signinUiUrl && (
          <div className="relative">
            <iframe
              ref={iframeRef}
              src={signinUiUrl}
              sandbox="allow-same-origin allow-scripts allow-forms"
              className="w-full h-[380px] rounded-xl border border-gray-200"
            />
          </div>
        )}
      </Modal>
    </>
  );
}
