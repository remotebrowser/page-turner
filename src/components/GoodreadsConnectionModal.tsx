import * as Sentry from '@sentry/react';
import { useEffect, useRef } from 'react';
import { apiClient, type GetBookListResponse } from '../api';
import goodreads from '../config/goodreads.json';
import type { BrandConfig } from '../modules/Config';
import { transformData, type Book } from '../modules/DataTransformSchema';
import Modal from './Modal';

const BRAND_CONFIG = goodreads as BrandConfig;
const SENTRY_TAGS = {
  component: 'GoodreadsConnectionModal',
  brand_id: BRAND_CONFIG.brand_id,
  brand_name: BRAND_CONFIG.brand_name,
};

type GoodreadsConnectionModalProps = {
  bookListData: GetBookListResponse;
  onSuccessConnect: (data: Book[]) => void;
  onConnectionError?: (errorDetails: string) => void;
  onProgressStep?: (step: number) => void;
  onAuthComplete?: () => void;
};

export function GoodreadsConnectionModal(props: GoodreadsConnectionModalProps) {
  const { bookListData } = props;
  const callbacksRef = useRef(props);
  callbacksRef.current = props;
  const activeKeyRef = useRef<string | null>(null);
  const startedBrowserPageRef = useRef<string | null>(null);
  const finalizedKeyRef = useRef<string | null>(null);
  const pendingFinalizeRef = useRef<{
    key: string;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);

  useEffect(() => {
    const browserId = bookListData.browserId;
    const pageId = bookListData.pageId;
    if (!browserId || !pageId) return;
    const key = `${browserId}:${pageId}`;
    activeKeyRef.current = key;

    const isStale = () => activeKeyRef.current !== key;

    // The remote browser keeps running until it is terminated, so terminate
    // it once, whichever way the connection ends.
    const finalize = () => {
      if (finalizedKeyRef.current === key) return;
      finalizedKeyRef.current = key;
      apiClient.finalizeBrowser(browserId, pageId).catch((error) => {
        Sentry.captureException(error, { tags: SENTRY_TAGS });
      });
    };

    // StrictMode unmounts and remounts in development; keep the browser if
    // the same one comes straight back.
    if (pendingFinalizeRef.current?.key === key) {
      clearTimeout(pendingFinalizeRef.current.timer);
      pendingFinalizeRef.current = null;
    }

    const onDistilled = (event: MessageEvent) => {
      const payload = event.data as {
        type?: string;
        browserId?: string;
        pageId?: string;
        data?: unknown;
      };
      if (!payload || typeof payload !== 'object') return;
      if (payload.type !== 'pageturner:distilled') return;
      if (payload.browserId !== browserId || payload.pageId !== pageId) return;
      if (isStale()) return;

      try {
        const transformedData = transformData(
          payload.data,
          BRAND_CONFIG.dataTransform
        );
        callbacksRef.current.onAuthComplete?.();
        callbacksRef.current.onSuccessConnect(
          transformedData as unknown as Book[]
        );
        finalize();
      } catch (error) {
        finalize();
        if (isStale()) return;
        Sentry.captureException(error, {
          tags: SENTRY_TAGS,
          extra: { brandConfig: BRAND_CONFIG },
        });
        callbacksRef.current.onConnectionError?.(
          error instanceof Error ? error.message : 'Unknown connection error'
        );
      }
    };

    window.addEventListener('message', onDistilled);
    window.addEventListener('pagehide', finalize);
    if (startedBrowserPageRef.current !== key) {
      startedBrowserPageRef.current = key;
      callbacksRef.current.onProgressStep?.(2);
    }

    return () => {
      window.removeEventListener('message', onDistilled);
      window.removeEventListener('pagehide', finalize);
      if (activeKeyRef.current === key) {
        activeKeyRef.current = null;
      }
      pendingFinalizeRef.current = {
        key,
        timer: setTimeout(() => {
          pendingFinalizeRef.current = null;
          finalize();
        }, 0),
      };
    };
  }, [bookListData.browserId, bookListData.pageId]);

  const { browserId, pageId } = bookListData;
  if (!browserId || !pageId) return;

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
          src={`/api/dpage/${browserId}/${pageId}`}
          sandbox="allow-same-origin allow-scripts allow-forms"
          className="w-full h-[380px] rounded-xl border border-gray-200"
        />
      </div>
    </Modal>
  );
}
