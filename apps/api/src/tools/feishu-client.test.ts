import { describe, expect, test, vi } from "vitest";
import { FeishuContentClient } from "./feishu-client.js";

describe("FeishuContentClient", () => {
  test("searches docs and Wiki with the current user's token", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        data: {
          total: 332,
          has_more: true,
          page_token: "page-2",
          res_units: [
            {
              entity_type: "WIKI",
              title_highlighted: "<h>AI</h> 产品 <hb>PRD</hb> 模板0715",
              summary_highlighted: "面向 <h>AI</h> 产品的评审<hb>模板</hb>",
              result_meta: {
                token: "doc-1",
                url: "https://example.feishu.cn/docx/doc-1",
                doc_types: "docx",
                owner_id: "ou_owner",
                update_time: 1784620800,
              },
            },
          ],
        },
      }),
    );
    const client = new FeishuContentClient("user-access-token", fetch);

    await expect(client.search("AI", { pageSize: 15 })).resolves.toEqual({
      total: 332,
      hasMore: true,
      nextPageToken: "page-2",
      results: [
        {
          title: "AI 产品 PRD 模板0715",
          summary: "面向 AI 产品的评审模板",
          url: "https://example.feishu.cn/docx/doc-1",
          token: "doc-1",
          entityType: "WIKI",
          ownerId: "ou_owner",
          updatedAt: "1784620800",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://open.feishu.cn/open-apis/search/v2/doc_wiki/search",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer user-access-token" }),
        body: JSON.stringify({
          query: "AI",
          page_size: 15,
          page_token: "",
          doc_filter: {},
          wiki_filter: {},
        }),
      }),
    );
  });

  test("resolves a Wiki node and reads paginated Docx blocks with citations", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            node: {
              node_token: "wiki-node",
              obj_token: "doc-token",
              obj_type: "docx",
              space_id: "space-1",
              title: "方案",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: { document: { document_id: "doc-token", title: "方案", revision_id: 12 } },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            has_more: true,
            page_token: "page-2",
            items: [
              {
                block_id: "block-1",
                block_type: 2,
                text: { elements: [{ text_run: { content: "第一段" } }] },
              },
            ],
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            has_more: false,
            items: [
              {
                block_id: "block-2",
                block_type: 3,
                heading1: { elements: [{ text_run: { content: "第二节" } }] },
              },
            ],
          },
        }),
      );
    const client = new FeishuContentClient("user-access-token", fetch);
    const originalUrl = "https://example.feishu.cn/wiki/wiki-node";

    await expect(client.readDocument(originalUrl)).resolves.toEqual({
      documentId: "doc-token",
      title: "方案",
      revisionId: 12,
      url: originalUrl,
      blocks: [
        { blockId: "block-1", text: "第一段", citation: `${originalUrl}#block-1` },
        { blockId: "block-2", text: "第二节", citation: `${originalUrl}#block-2` },
      ],
    });

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=wiki-node&obj_type=wiki",
    );
    expect(fetch.mock.calls[3]?.[0]).toContain("page_token=page-2");
  });

  test("enforces Feishu search limits before making a request", async () => {
    const fetch = vi.fn();
    const client = new FeishuContentClient("user-access-token", fetch);

    await expect(client.search("a".repeat(31))).rejects.toThrow(
      "Feishu search query must contain at most 30 Unicode code points",
    );
    await expect(client.search("valid", { pageSize: 21 })).rejects.toThrow(
      "Feishu search page size must be between 1 and 20",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  test("creates a Docx and appends readable text blocks with the current user's token", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            document: { document_id: "doc-created", revision_id: 1, title: "华东出差计划" },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          code: 0,
          data: {
            document_revision_id: 2,
            children: [{ block_id: "block-1" }, { block_id: "block-2" }],
          },
        }),
      );
    const client = new FeishuContentClient("user-access-token", fetch);

    await expect(
      client.createDocument({
        title: "华东出差计划",
        content: "# 行程\n\n上海\n杭州",
      }),
    ).resolves.toEqual({
      documentId: "doc-created",
      revisionId: 2,
      title: "华东出差计划",
      url: "https://feishu.cn/docx/doc-created",
      blockCount: 3,
    });
    expect(fetch.mock.calls[0]).toEqual([
      "https://open.feishu.cn/open-apis/docx/v1/documents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "华东出差计划" }),
      }),
    ]);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "https://open.feishu.cn/open-apis/docx/v1/documents/doc-created/blocks/doc-created/children",
    );
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      index: -1,
      children: [
        {
          block_type: 2,
          text: { elements: [{ text_run: { content: "# 行程" } }] },
        },
        {
          block_type: 2,
          text: { elements: [{ text_run: { content: "上海" } }] },
        },
        {
          block_type: 2,
          text: { elements: [{ text_run: { content: "杭州" } }] },
        },
      ],
    });
  });

  test("appends content to an existing Docx URL", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        code: 0,
        data: { document_revision_id: 9, children: [{ block_id: "block-1" }] },
      }),
    );
    const client = new FeishuContentClient("user-access-token", fetch);

    await expect(
      client.updateDocument({
        url: "https://example.feishu.cn/docx/doc-existing",
        content: "补充事项",
      }),
    ).resolves.toEqual({
      documentId: "doc-existing",
      revisionId: 9,
      url: "https://example.feishu.cn/docx/doc-existing",
      blockCount: 1,
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
