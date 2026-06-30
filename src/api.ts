import { getSessionHeaders } from './sessionContext';

const API_BASE_URL = '/api';

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

export type GetBookListResponse = {
  browserId?: string;
  pageId?: string;
};

type PollAuthResponse = {
  status?: string;
  data?: unknown;
};

export class ApiClient {
  private baseUrl: string;

  constructor(baseUrl: string = API_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...getSessionHeaders(),
        ...options.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result: ApiResponse<T> = await response.json();

    if (!result.success) {
      throw new Error(result.error || 'API request failed');
    }

    return result.data as T;
  }

  async getBookList(keywords: string[] = []): Promise<GetBookListResponse> {
    return this.request<GetBookListResponse>('/get-book-list', {
      method: 'POST',
      body: JSON.stringify({ keywords }),
    });
  }

  async pollBrowser(
    browserId: string,
    pageId: string
  ): Promise<PollAuthResponse> {
    return this.request<PollAuthResponse>('/poll-browser', {
      method: 'POST',
      body: JSON.stringify({ browser_id: browserId, page_id: pageId }),
    });
  }

  async finalizeBrowser(browserId: string, pageId: string): Promise<void> {
    return this.request<void>('/finalize-browser', {
      method: 'POST',
      body: JSON.stringify({ browser_id: browserId, page_id: pageId }),
    });
  }
}

export const apiClient = new ApiClient();
