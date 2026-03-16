const API_BASE_URL = '/api';

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

type GetBookListResponse = {
  url: string;
  signin_id: string;
  ui_resource_uri?: string | null;
  tool_result?: unknown;
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
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
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

  async pollSignin(signinId: string): Promise<PollAuthResponse> {
    return this.request<PollAuthResponse>('/poll-signin', {
      method: 'POST',
      body: JSON.stringify({ signin_id: signinId }),
    });
  }

  async finalizeSignin(signinId: string): Promise<void> {
    return this.request<void>('/finalize-signin', {
      method: 'POST',
      body: JSON.stringify({ signin_id: signinId }),
    });
  }
}

export const apiClient = new ApiClient();
