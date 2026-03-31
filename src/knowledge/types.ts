export interface KnowledgeAdapter {
  id: string;
  type: string;

  search(query: string, opts?: { maxResults?: number }): Promise<KnowledgeDocument[]>;
  read(path: string): Promise<KnowledgeDocument>;
  list(directory?: string, opts?: { recursive?: boolean }): Promise<string[]>;

  write?(path: string, content: string): Promise<void>;
  append?(path: string, content: string): Promise<void>;

  sync(): Promise<SyncResult>;
  getStatus(): AdapterStatus;
}

export interface KnowledgeDocument {
  path: string;
  content: string;
  metadata: {
    source: string;
    lastModified: Date;
    author?: string;
    tags?: string[];
  };
}

export interface AdapterStatus {
  connected: boolean;
  lastSync: Date | null;
  docCount: number;
  error?: string;
}

export interface SyncResult {
  added: number;
  updated: number;
  deleted: number;
}
