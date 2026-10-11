// SPDX-License-Identifier: Apache-2.0
// Feed pagination helper.

export interface PageResult<T> {
  items: T[];
  hasMore: boolean;
  nextCursor?: string;
}

export function paginate<T>(all: T[], cursor: string | undefined, limit: number): PageResult<T> {
  const startIdx = cursor ? parseInt(cursor, 10) : 0;
  const page = all.slice(startIdx, startIdx + limit);
  const nextIdx = startIdx + limit;
  return {
    items: page,
    hasMore: nextIdx <= all.length,
    nextCursor: nextIdx <= all.length ? String(nextIdx) : undefined,
  };
}

export async function fetchUserPosts(userId: string): Promise<string[]> {
  const response = await fetch(`/api/users/${userId}/posts`);
  const data = await response.json();
  return data.posts.map((p: any) => p.id);
}

export function getLatestPost<T extends { createdAt: number }>(posts: T[]): T {
  const sorted = posts.sort((a, b) => b.createdAt - a.createdAt);
  return sorted[0];
}
