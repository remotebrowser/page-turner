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

  useEffect(() => {
    const browserId = bookListData.browserId;
    const pageId = bookListData.pageId;
    if (!browserId || !pageId) return;
    const key = `${browserId}:${pageId}`;
    activeKeyRef.current = key;

    const isStale = () => activeKeyRef.current !== key;

    const onPollBrowser = async () => {
      try {
        callbacksRef.current.onProgressStep?.(2);
        let pollResult;
        while (true) {
          if (isStale()) {
            return;
          }
          try {
            pollResult = await apiClient.pollBrowser(browserId, pageId);
            if (pollResult?.status === 'SUCCESS') {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 3000));
          } catch (error) {
            if (isStale()) return;
            Sentry.captureException(error, { tags: SENTRY_TAGS });
          }
        }

        if (isStale()) return;
        const transformedData = transformData(
          pollResult,
          BRAND_CONFIG.dataTransform
        );
        callbacksRef.current.onAuthComplete?.();
        callbacksRef.current.onSuccessConnect(
          transformedData as unknown as Book[]
        );
        apiClient.finalizeBrowser(browserId, pageId);
      } catch (error) {
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

    if (startedBrowserPageRef.current !== key) {
      startedBrowserPageRef.current = key;
      void onPollBrowser();
    }

    return () => {
      if (activeKeyRef.current === key) {
        activeKeyRef.current = null;
      }
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
