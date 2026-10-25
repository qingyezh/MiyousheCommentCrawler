const BBS = 'https://bbs-api.miyoushe.com';

export function postFullUrl(gids: number | null, postId: string): string {
  const g = gids ?? 2;
  return `${BBS}/post/wapi/getPostFull?gids=${g}&post_id=${postId}&read=1`;
}

export function repliesUrl(opts: {
  postId: string;
  size: number;
  orderType: 1 | 2;
  lastId: string | number;
}): string {
  return `${BBS}/post/wapi/getPostReplies?post_id=${opts.postId}&size=${opts.size}&order_type=${opts.orderType}&last_id=${opts.lastId}`;
}

export function subRepliesUrl(opts: {
  postId: string;
  floorId: number;
  size: number;
  lastId: string | number;
}): string {
  return `${BBS}/post/wapi/getSubReplies?post_id=${opts.postId}&floor_id=${opts.floorId}&size=${opts.size}&last_id=${opts.lastId}`;
}

export function userFullInfoUrl(uid: string): string {
  return `${BBS}/user/wapi/getUserFullInfo?uid=${uid}`;
}

export function gameListUrl(): string {
  return `${BBS}/apihub/wapi/getGameList`;
}
