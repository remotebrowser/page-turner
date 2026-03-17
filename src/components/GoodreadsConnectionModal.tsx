import { useEffect, useRef } from 'react';
import { transformData, type Book } from '../modules/DataTransformSchema';
import { apiClient, type GetBookListResponse } from '../api';
import * as Sentry from '@sentry/react';
import Modal from './Modal';
import goodreads from '../config/goodreads.json';
import type { BrandConfig } from '../modules/Config';

const BRAND_CONFIG = goodreads as BrandConfig;
const SENTRY_TAGS = {
  component: 'GoodreadsConnectionModal',
  brand_id: BRAND_CONFIG.brand_id,
  brand_name: BRAND_CONFIG.brand_name,
};

function buildIframeUrl(
  uiResourceUri: string | null | undefined,
  signinUrl?: string
): string {
  const base = uiResourceUri
    ? `/api/mcp-apps/ui?resourceUri=${encodeURIComponent(uiResourceUri)}${
        signinUrl ? `&signin_url=${encodeURIComponent(signinUrl)}` : ''
      }`
    : (signinUrl ?? '');
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}theme=light`;
}

type GoodreadsConnectionModalProps = {
  bookListData: GetBookListResponse;
  onSuccessConnect: (data: Book[]) => void;
  onConnectionError?: (errorDetails: string) => void;
  onProgressStep?: (step: number) => void;
  onAuthComplete?: () => void;
};

export function GoodreadsConnectionModal(props: GoodreadsConnectionModalProps) {
  const { bookListData } = props;
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;

  const signinUiUrl = buildIframeUrl(
    bookListData.ui_resource_uri,
    bookListData.url
  );

  useEffect(() => {
    let cancelled = false;

    const onPollAuth = async () => {
      try {
        callbacksRef.current.onProgressStep?.(2);
        let pollResult;
        while (true) {
          if (cancelled) return;
          try {
            pollResult = await apiClient.pollSignin(bookListData.signin_id);
            if (pollResult?.status === 'SUCCESS') break;
          } catch (error) {
            Sentry.captureException(error, { tags: SENTRY_TAGS });
          }
        }

        if (cancelled) return;
        const transformedData = transformData(
          pollResult,
          BRAND_CONFIG.dataTransform
        );
        callbacksRef.current.onAuthComplete?.();
        callbacksRef.current.onSuccessConnect(
          transformedData as unknown as Book[]
        );
        apiClient.finalizeSignin(bookListData.signin_id);
      } catch (error) {
        if (cancelled) return;
        Sentry.captureException(error, {
          tags: SENTRY_TAGS,
          extra: { brandConfig: BRAND_CONFIG },
        });
        callbacksRef.current.onConnectionError?.(
          error instanceof Error ? error.message : 'Unknown connection error'
        );
      }
    };

    onPollAuth();

    return () => {
      cancelled = true;
    };
  }, [bookListData.signin_id]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const onLoad = () => {
      try {
        iframe.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: bookListData.tool_result,
          },
          '*'
        );
      } catch (error) {
        console.error('Failed to post tool-result message to iframe', error);
      }
    };

    const onMessage = (event: MessageEvent) => {
      const message = event.data;
      if (
        !message ||
        message.jsonrpc !== '2.0' ||
        message.method !== 'ui/initialize'
      )
        return;

      try {
        iframe.contentWindow?.postMessage(
          {
            jsonrpc: '2.0',
            id: message.id,
            result: { hostContext: { theme: 'light' } },
          },
          '*'
        );
      } catch (error) {
        console.error('Failed to post ui/initialize response', error);
      }
    };

    iframe.addEventListener('load', onLoad);
    window.addEventListener('message', onMessage);

    return () => {
      iframe.removeEventListener('load', onLoad);
      window.removeEventListener('message', onMessage);
    };
  }, [bookListData.tool_result]);

  return (
    <Modal
      title={
        <div className="flex items-center gap-3">
          <img
            src={BRAND_CONFIG.logo_url}
            alt={`${BRAND_CONFIG.brand_name} logo`}
            className="w-8 h-8 object-contain"
          />
          <h3 className="font-medium">{BRAND_CONFIG.brand_name}</h3>
        </div>
      }
      open={true}
    >
      <div className="relative pt-5">
        <iframe
          ref={iframeRef}
          src={signinUiUrl}
          sandbox="allow-same-origin allow-scripts allow-forms"
          className="w-full h-[380px] rounded-xl border border-gray-200"
        />
      </div>
    </Modal>
  );
}
