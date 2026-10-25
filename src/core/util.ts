/** 内存去重集合；支持从已有 uid 列表恢复 */
export class UidSet {
  private set = new Set<string>();

  has(uid: string): boolean {
    return this.set.has(uid);
  }

  add(uid: string): boolean {
    if (this.set.has(uid)) return false;
    this.set.add(uid);
    return true;
  }

  get size() {
    return this.set.size;
  }

  values(): string[] {
    return [...this.set];
  }

  load(uids: Iterable<string>) {
    for (const u of uids) this.set.add(u);
  }
}

/** 帖子 URL 解析 */
export function parseMiyousheUrl(url: string): { postId: string; gids: number | null; gamePath: string | null } {
  const u = new URL(url.trim());
  // https://www.miyoushe.com/ys/article/79098964
  // https://www.mihoyo.com/ys/article/xxx
  // also ?post_id=
  const qp = u.searchParams.get('post_id');
  const m = u.pathname.match(/\/([a-z0-9_-]+)\/article\/(\d+)/i);
  if (m) {
    return { postId: m[2], gamePath: m[1], gids: gamePathToGids(m[1]) };
  }
  if (qp) {
    return { postId: qp, gamePath: u.searchParams.get('game_path'), gids: null };
  }
  throw new Error(`无法从 URL 解析 post_id: ${url}`);
}

const GAME_PATH_GIDS: Record<string, number> = {
  ys: 2,
  sr: 6,
  zzz: 8,
  bh3: 1,
  honkai: 1,
  wd: 5,
  hyg: 10,
};

export function gamePathToGids(p: string | null | undefined): number | null {
  if (!p) return null;
  return GAME_PATH_GIDS[p.toLowerCase()] ?? null;
}

export function gidsFromPostMeta(post: { game_id?: number; f_forum_id?: number } | null): number | null {
  if (post?.game_id != null) return post.game_id;
  return null;
}
