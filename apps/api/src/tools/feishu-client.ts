type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface FeishuSearchResult {
  token: string;
  url: string;
  title: string;
  summary: string;
  entityType: string;
  ownerId: string | null;
  updatedAt: string | null;
}

export interface FeishuSearchResponse {
  total: number;
  hasMore: boolean;
  nextPageToken: string | null;
  results: FeishuSearchResult[];
}

export interface FeishuDocumentBlock {
  blockId: string;
  text: string;
  citation: string;
}

export interface FeishuDocument {
  documentId: string;
  title: string;
  revisionId: number;
  url: string;
  blocks: FeishuDocumentBlock[];
}

export interface FeishuDocumentWriteResult {
  documentId: string;
  revisionId: number;
  url: string;
  blockCount: number;
}

export interface FeishuCreatedDocument extends FeishuDocumentWriteResult {
  title: string;
}

export class FeishuContentError extends Error {
  readonly name = "FeishuContentError";

  constructor(
    message: string,
    readonly code: number,
    readonly status: number,
  ) {
    super(message);
  }
}

export class FeishuContentClient {
  constructor(
    private readonly accessToken: string,
    private readonly fetch: FetchLike = globalThis.fetch,
  ) {}

  async search(
    query: string,
    options: { pageSize?: number; pageToken?: string } = {},
  ): Promise<FeishuSearchResponse> {
    if (Array.from(query).length > 30) {
      throw new Error("Feishu search query must contain at most 30 Unicode code points");
    }
    const pageSize = options.pageSize ?? 15;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 20) {
      throw new Error("Feishu search page size must be between 1 and 20");
    }
    const body = await this.request("/open-apis/search/v2/doc_wiki/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        page_size: pageSize,
        page_token: options.pageToken ?? "",
        doc_filter: {},
        wiki_filter: {},
      }),
    });
    const data = asRecord(body.data);
    const results = Array.isArray(data.res_units)
      ? data.res_units
      : Array.isArray(data.results)
        ? data.results
        : [];
    return {
      total: numberOr(data.total, results.length),
      hasMore: data.has_more === true,
      nextPageToken: optionalString(data.page_token),
      results: results.map((value) => {
        const item = asRecord(value);
        const meta = asRecord(item.result_meta);
        return {
          token: requiredString(meta.token, "search result token"),
          url: requiredString(meta.url, "search result URL"),
          title: stripHighlightTags(stringOr(item.title_highlighted, "")),
          summary: stripHighlightTags(stringOr(item.summary_highlighted, "")),
          entityType: stringOr(item.entity_type, stringOr(meta.doc_types, "unknown")),
          ownerId: optionalString(meta.owner_id),
          updatedAt: optionalScalarString(meta.update_time),
        };
      }),
    };
  }

  async readDocument(inputUrl: string): Promise<FeishuDocument> {
    const url = parseDocumentUrl(inputUrl);
    let documentId = url.token;
    if (url.type === "wiki") {
      const query = new URLSearchParams({ token: url.token, obj_type: "wiki" });
      const nodeBody = await this.request(`/open-apis/wiki/v2/spaces/get_node?${query}`);
      const data = asRecord(nodeBody.data);
      const node = Object.keys(asRecord(data.node)).length > 0 ? asRecord(data.node) : data;
      if (node.obj_type !== "docx") {
        throw new Error(`Unsupported Wiki object type: ${stringOr(node.obj_type, "unknown")}`);
      }
      documentId = requiredString(node.obj_token, "Wiki obj_token");
    }

    const metadataBody = await this.request(
      `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,
    );
    const metadata = asRecord(asRecord(metadataBody.data).document);
    const title = requiredString(metadata.title, "document title");
    const revisionId = numberOr(metadata.revision_id, 0);
    const blocks: FeishuDocumentBlock[] = [];
    let pageToken: string | null = null;
    let pages = 0;

    do {
      const query = new URLSearchParams({ page_size: "500" });
      if (pageToken) query.set("page_token", pageToken);
      const blockBody = await this.request(
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${query}`,
      );
      const data = asRecord(blockBody.data);
      const items = Array.isArray(data.items) ? data.items : [];
      for (const value of items) {
        const block = asRecord(value);
        const blockId = requiredString(block.block_id, "block_id");
        const text = extractBlockText(block);
        if (!text) continue;
        blocks.push({ blockId, text, citation: `${inputUrl}#${blockId}` });
      }
      pageToken = data.has_more === true ? optionalString(data.page_token) : null;
      pages += 1;
      if (pages >= 20 && pageToken) {
        throw new Error("Feishu document exceeds the 10,000 block safety limit");
      }
    } while (pageToken);

    return {
      documentId,
      title,
      revisionId,
      url: inputUrl,
      blocks,
    };
  }

  async createDocument(input: {
    title: string;
    content: string;
    folderToken?: string;
  }): Promise<FeishuCreatedDocument> {
    const title = validateDocumentTitle(input.title);
    const content = validateDocumentContent(input.content);
    const body = await this.request("/open-apis/docx/v1/documents", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        title,
        ...(input.folderToken ? { folder_token: validateFolderToken(input.folderToken) } : {}),
      }),
    });
    const document = asRecord(asRecord(body.data).document);
    const documentId = requiredString(document.document_id, "document_id");
    const createdRevisionId = numberOr(document.revision_id, 0);
    const appended = await this.appendTextBlocks(documentId, content);
    return {
      documentId,
      revisionId: appended.revisionId || createdRevisionId,
      title: stringOr(document.title, title),
      url: `https://feishu.cn/docx/${documentId}`,
      blockCount: appended.blockCount,
    };
  }

  async updateDocument(input: {
    url: string;
    content: string;
  }): Promise<FeishuDocumentWriteResult> {
    const parsed = parseDocumentUrl(input.url);
    if (parsed.type !== "docx") {
      throw new Error("Feishu document update currently requires a Docx URL");
    }
    const appended = await this.appendTextBlocks(
      parsed.token,
      validateDocumentContent(input.content),
    );
    return {
      documentId: parsed.token,
      revisionId: appended.revisionId,
      url: input.url,
      blockCount: appended.blockCount,
    };
  }

  private async appendTextBlocks(
    documentId: string,
    content: string,
  ): Promise<{ revisionId: number; blockCount: number }> {
    const textBlocks = contentToTextBlocks(content);
    let revisionId = 0;
    for (let index = 0; index < textBlocks.length; index += 50) {
      const batch = textBlocks.slice(index, index + 50);
      const body = await this.request(
        `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            index: -1,
            children: batch.map((text) => ({
              block_type: 2,
              text: {
                elements: [{ text_run: { content: text } }],
              },
            })),
          }),
        },
      );
      revisionId = numberOr(asRecord(body.data).document_revision_id, revisionId);
    }
    return { revisionId, blockCount: textBlocks.length };
  }

  private async request(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.fetch(`https://open.feishu.cn${path}`, {
      ...init,
      headers: {
        ...headersToRecord(init.headers),
        Authorization: `Bearer ${this.accessToken}`,
      },
    });
    let body: Record<string, unknown>;
    try {
      body = asRecord(await response.json());
    } catch {
      throw new FeishuContentError("Feishu returned invalid JSON", -1, response.status);
    }
    const code = typeof body.code === "number" ? body.code : 0;
    if (!response.ok || code !== 0) {
      throw new FeishuContentError(
        stringOr(body.msg, stringOr(body.message, "Feishu content request failed")),
        code || response.status,
        response.status,
      );
    }
    return body;
  }
}

function parseDocumentUrl(input: string): { type: "wiki" | "docx"; token: string } {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Feishu document input must be a Wiki or Docx URL");
  }
  const match = url.pathname.match(/\/(wiki|docx)\/([A-Za-z0-9_-]+)/);
  if (!match?.[1] || !match[2]) {
    throw new Error("Feishu document input must be a Wiki or Docx URL");
  }
  return { type: match[1] as "wiki" | "docx", token: match[2] };
}

function validateDocumentTitle(value: string): string {
  const title = value.trim();
  if (title.length < 1 || title.length > 800) {
    throw new Error("Feishu document title must contain between 1 and 800 characters");
  }
  return title;
}

function validateDocumentContent(value: string): string {
  const content = value.trim();
  if (content.length < 1 || content.length > 100_000) {
    throw new Error("Feishu document content must contain between 1 and 100000 characters");
  }
  return content;
}

function validateFolderToken(value: string): string {
  if (!/^[A-Za-z0-9_-]{4,256}$/.test(value)) {
    throw new Error("Invalid Feishu folder token");
  }
  return value;
}

function contentToTextBlocks(content: string): string[] {
  const blocks: string[] = [];
  for (const line of content.split(/\r?\n/).map((item) => item.trim())) {
    if (!line) continue;
    for (let offset = 0; offset < line.length; offset += 2_000) {
      blocks.push(line.slice(offset, offset + 2_000));
    }
  }
  if (blocks.length === 0) throw new Error("Feishu document content contains no readable text");
  if (blocks.length > 500) throw new Error("Feishu document content exceeds the 500 block limit");
  return blocks;
}

function extractBlockText(block: Record<string, unknown>): string {
  const contentKeys = [
    "text",
    "heading1",
    "heading2",
    "heading3",
    "heading4",
    "heading5",
    "heading6",
    "heading7",
    "heading8",
    "heading9",
    "bullet",
    "ordered",
    "code",
    "quote",
    "todo",
  ];
  for (const key of contentKeys) {
    const content = asRecord(block[key]);
    if (!Array.isArray(content.elements)) continue;
    return content.elements
      .map((element) => stringOr(asRecord(asRecord(element).text_run).content, ""))
      .join("")
      .trim();
  }
  return "";
}

function stripHighlightTags(value: string): string {
  return value.replace(/<\/?(?:em|h|hb)>/gi, "");
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  return Object.fromEntries(new Headers(headers).entries());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${field}`);
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalScalarString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return optionalString(value);
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
