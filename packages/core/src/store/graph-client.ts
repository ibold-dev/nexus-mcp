import { FalkorDB } from "falkordb";

export type QueryParam = string | number | boolean | null;
export type QueryParams = Record<string, QueryParam>;

export interface GraphClient {
  query<T>(cypher: string, params?: QueryParams): Promise<T[]>;
  createRangeIndex(label: string, property: string): Promise<void>;
  deleteGraph(): Promise<void>;
  close(): Promise<void>;
}

export async function connectGraph(url: string, graphName: string): Promise<GraphClient> {
  const db = await FalkorDB.connect({ url });
  const graph = db.selectGraph(graphName);

  return {
    async query<T>(cypher: string, params?: QueryParams): Promise<T[]> {
      const result = await graph.query<T>(cypher, params ? { params } : undefined);
      return result.data ?? [];
    },
    async createRangeIndex(label: string, property: string): Promise<void> {
      try {
        await graph.createNodeRangeIndex(label, property);
      } catch (error) {
        if (!(error instanceof Error) || !/already/i.test(error.message)) {
          throw error;
        }
      }
    },
    async deleteGraph(): Promise<void> {
      await graph.delete();
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
