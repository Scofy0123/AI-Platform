import { describe, expect, test } from "vitest";
import { FeishuContentClient } from "../../apps/api/src/tools/feishu-client.js";
import { requireSmokeEnv, rethrowWithoutSecrets } from "./smoke-env.js";

describe("real Feishu integration", () => {
  test.skipIf(process.env.REAL_FEISHU_E2E !== "1")(
    "searches and reads content with the current user's OAuth token",
    async () => {
      const accessToken = requireSmokeEnv("FEISHU_E2E_USER_ACCESS_TOKEN");
      const documentUrl = requireSmokeEnv("FEISHU_E2E_DOCUMENT_URL");
      const searchQuery = process.env.FEISHU_E2E_SEARCH_QUERY?.trim() || "AI";
      const client = new FeishuContentClient(accessToken);

      try {
        const search = await client.search(searchQuery, { pageSize: 1 });
        expect(search.total).toBeGreaterThanOrEqual(0);
        expect(search.results.length).toBeLessThanOrEqual(1);
        expect(typeof search.hasMore).toBe("boolean");

        const document = await client.readDocument(documentUrl);
        expect(document.url).toBe(documentUrl);
        expect(document.documentId).not.toBe("");
        expect(document.title).not.toBe("");
        expect(document.revisionId).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(document.blocks)).toBe(true);
      } catch (error) {
        rethrowWithoutSecrets(error, [accessToken]);
      }
    },
    60_000,
  );
});
