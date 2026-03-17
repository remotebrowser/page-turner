import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrandConfig } from '../modules/Config';
import { transformData, type Book } from '../modules/DataTransformSchema';
import { apiClient } from '../api';
import * as Sentry from '@sentry/react';
import Modal from './Modal';
import goodreads from '../config/goodreads.json';

const goodreadsConfig = goodreads as BrandConfig;

let getBookListPromise: ReturnType<typeof apiClient.getBookList> | null = null;

function clearGetBookListPromise() {
  getBookListPromise = null;
}

type GoodreadsConnectionModalProps = {
  onSuccessConnect: (data: Book[]) => void;
  onConnectionError?: (errorDetails: string) => void;
  onProgressStep?: (step: number) => void;
  onAuthComplete?: () => void;
};

export function GoodreadsConnectionModal({
  onSuccessConnect,
  onConnectionError,
  onProgressStep,
  onAuthComplete,
}: GoodreadsConnectionModalProps) {
  const brandConfig = goodreadsConfig;
  const [signinUiUrl, setSigninUiUrl] = useState<string | undefined>();
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [initialToolResult, setInitialToolResult] = useState<unknown>();

  const onSuccessConnectRef = useRef(onSuccessConnect);
  const onConnectionErrorRef = useRef(onConnectionError);
  const onProgressStepRef = useRef(onProgressStep);
  const onAuthCompleteRef = useRef(onAuthComplete);
  onSuccessConnectRef.current = onSuccessConnect;
  onConnectionErrorRef.current = onConnectionError;
  onProgressStepRef.current = onProgressStep;
  onAuthCompleteRef.current = onAuthComplete;

  const startAuthentication = useCallback(
    async (signinId: string) => {
      try {
        onProgressStepRef.current?.(2);
        let pollResult;
        while (true) {
          try {
            pollResult = await apiClient.pollSignin(signinId);
            if (pollResult?.status === 'SUCCESS') break;
          } catch (error) {
            Sentry.captureException(error, {
              tags: {
                component: 'GoodreadsConnectionModal',
                brand_id: brandConfig.brand_id,
                brand_name: brandConfig.brand_name,
              },
            });
          }
        }

        const transformedData = transformData(
          pollResult,
          brandConfig.dataTransform
        );
        onAuthCompleteRef.current?.();
        clearGetBookListPromise();
        onSuccessConnectRef.current(transformedData as unknown as Book[]);
        apiClient.finalizeSignin(signinId);
      } catch (error) {
        Sentry.captureException(error, {
          tags: {
            component: 'GoodreadsConnectionModal',
            brand_id: brandConfig.brand_id,
            brand_name: brandConfig.brand_name,
          },
          extra: { brandConfig },
        });
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown connection error';
        clearGetBookListPromise();
        onConnectionErrorRef.current?.(errorMessage);
      }
    },
    [brandConfig]
  );

  useEffect(() => {
    let cancelled = false;

    if (!getBookListPromise) {
      getBookListPromise = apiClient.getBookList();
    }

    getBookListPromise
      .then((response) => {
        if (cancelled) return;
        setInitialToolResult(response.tool_result);
        const baseUrl = response.ui_resource_uri
          ? `/api/mcp-apps/ui?resourceUri=${encodeURIComponent(
              response.ui_resource_uri
            )}${response.url ? `&signin_url=${encodeURIComponent(response.url)}` : ''}`
          : (response.url ?? '');
        const separator = baseUrl.includes('?') ? '&' : '?';
        const iframeUrl = `${baseUrl}${separator}theme=light`;
        setSigninUiUrl(iframeUrl ?? undefined);
        startAuthentication(response.signin_id);
      })
      .catch((error) => {
        if (cancelled) return;
        clearGetBookListPromise();
        onConnectionErrorRef.current?.(
          error instanceof Error
            ? error.message
            : 'Failed to start Goodreads signin UI'
        );
      });

    return () => {
      cancelled = true;
      const p = getBookListPromise;
      setTimeout(() => {
        if (getBookListPromise === p) clearGetBookListPromise();
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount; callbacks read via refs
  }, []);

  useEffect(() => {
    if (!signinUiUrl || !initialToolResult) return;

    const iframe = iframeRef.current;
    if (!iframe) return;

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

    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.jsonrpc !== '2.0') {
        return;
      }

      if (message.method === 'ui/initialize') {
        const response = {
          jsonrpc: '2.0',
          id: message.id,
          result: {
            hostContext: {
              theme: 'light',
            },
          },
        };

        try {
          iframe.contentWindow?.postMessage(response, '*');
        } catch (error) {
          console.error('Failed to post ui/initialize response', error);
        }
      }
    };

    iframe.addEventListener('load', onLoad);
    window.addEventListener('message', onMessage);

    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', onMessage);
    };
  }, [signinUiUrl, initialToolResult]);

  return (
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
      open={true}
    >
      {signinUiUrl ? (
        <div className="relative pt-5">
          <iframe
            ref={iframeRef}
            src={signinUiUrl}
            sandbox="allow-same-origin allow-scripts allow-forms"
            className="w-full h-[380px] rounded-xl border border-gray-200"
          />
        </div>
      ) : (
        <div className="w-full h-[380px] flex items-center justify-center rounded-xl border border-gray-200 bg-gray-50">
          <p className="text-gray-500">Loading sign-in...</p>
        </div>
      )}
    </Modal>
  );
}
