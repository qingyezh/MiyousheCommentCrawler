import { parseMiyousheUrl } from '../../core/util.js';

const cases = [
  'https://www.miyoushe.com/ys/article/79098964',
  'https://www.miyoushe.com/ys/article/79085282',
];
for (const u of cases) {
  const p = parseMiyousheUrl(u);
  console.log(u, '=>', p);
  if (!p.postId) process.exit(1);
}
console.log('smoke ok');
