import assert from "node:assert/strict";
import test from "node:test";
import {
  extractInitDataBlocks,
  extractSerpProfiles,
  parseDetailProfile,
} from "./metadata.js";

const EDIT_PAGE_ID = "edjbgblhciojhakodeflnpampekciifl";
const ICON = "https://lh3.googleusercontent.com/uI8opi-ZIQ9awUT=s128-rj-sc0x00ffffff";

/** 与真实详情页一致的最小 HTML 片段。 */
function detailHtml(options: {
  canonical: string;
  title?: string;
  image?: string;
  description?: string;
}): string {
  const parts = [
    `<meta property="og:type" content="website">`,
    `<link rel="canonical" href="${options.canonical}">`,
  ];
  if (options.title !== undefined) parts.push(`<meta property="og:title" content="${options.title}">`);
  if (options.description !== undefined) parts.push(`<meta property="og:description" content="${options.description}">`);
  if (options.image !== undefined) parts.push(`<meta property="og:image" content="${options.image}">`);

  return `<html><head>${parts.join("")}</head><body></body></html>`;
}

test("详情页解析出标题、图标、描述与 slug", () => {
  const html = detailHtml({
    canonical: `https://chromewebstore.google.com/detail/edit-page-webpage-editor/${EDIT_PAGE_ID}`,
    title: "Edit Page - Webpage Editor &amp; Full Page Screenshot - Chrome Web Store",
    image: ICON,
    description: "Edit page text, replace images &amp; more.",
  });

  const profile = parseDetailProfile(html, EDIT_PAGE_ID);

  assert.ok(profile);
  assert.equal(profile.cwsId, EDIT_PAGE_ID);
  assert.equal(profile.title, "Edit Page - Webpage Editor & Full Page Screenshot");
  assert.equal(profile.iconUrl, ICON);
  assert.equal(profile.description, "Edit page text, replace images & more.");
  assert.equal(profile.slug, "edit-page-webpage-editor");
});

test("重定向到商店首页的响应会被拒绝，而不是把站点标题当成扩展标题", () => {
  const html = detailHtml({
    canonical: "https://chromewebstore.google.com/?hl=en",
    title: "Chrome Web Store",
    image: "https://ssl.gstatic.com/chrome/webstore/images/chrome_web_store_v2_1200x630.png",
  });

  assert.equal(parseDetailProfile(html, EDIT_PAGE_ID), null);
});

test("缺少 og:url 或 canonical 时拒绝猜测", () => {
  const html = `<html><head><meta property="og:title" content="Some Extension"></head></html>`;
  assert.equal(parseDetailProfile(html, EDIT_PAGE_ID), null);
});

test("content 在 property 之前的 meta 也能解析", () => {
  const html = `<html><head>
    <meta content="https://chromewebstore.google.com/detail/edit-page/${EDIT_PAGE_ID}" property="og:url">
    <meta content="Edit Page - Chrome Web Store" property="og:title">
    </head></html>`;

  const profile = parseDetailProfile(html, EDIT_PAGE_ID);
  assert.ok(profile);
  assert.equal(profile.title, "Edit Page");
});

test("SERP 内嵌数据里按结构提取扩展元数据", () => {
  const payload = [
    [
      [null, null],
      [
        [
          [
            [
              "clfiicjcpkcccglblehapeiipibnaenl",
              "https://lh3.googleusercontent.com/AbAUojfxtv609oNYr4rZmyEFRGt",
              "Page Edit",
              4.6,
              35,
              "https://lh3.googleusercontent.com/screenshot",
            ],
            [EDIT_PAGE_ID, ICON, "Edit Page", 4.6, 1200],
          ],
        ],
      ],
    ],
  ];

  const html = `<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify(payload)}, sideChannel: {}});</script><script>AF_initDataCallback({key: 'ds:0', hash: '1', data:[[1,0]], sideChannel: {}});</script>`;

  const profiles = extractSerpProfiles(html);
  const byId = new Map(profiles.map((profile) => [profile.cwsId, profile]));

  assert.equal(profiles.length, 2);
  assert.equal(byId.get("clfiicjcpkcccglblehapeiipibnaenl")?.title, "Page Edit");
  assert.equal(byId.get("clfiicjcpkcccglblehapeiipibnaenl")?.rating, 4.6);
  assert.equal(byId.get("clfiicjcpkcccglblehapeiipibnaenl")?.ratingCount, 35);
  assert.equal(byId.get(EDIT_PAGE_ID)?.iconUrl, ICON);
  assert.equal(byId.get(EDIT_PAGE_ID)?.ratingCount, 1200);
});

test("忽略不构成扩展记录的数组", () => {
  const payload = [[["not-an-extension-id", "https://lh3.googleusercontent.com/x", "Nope"]]];
  const html = `<script>AF_initDataCallback({key: 'ds:1', data:${JSON.stringify(payload)}, sideChannel: {}});</script>`;

  assert.deepEqual(extractSerpProfiles(html), []);
});

test("数据块被截断或不是合法 JSON 时返回空数组", () => {
  assert.deepEqual(extractSerpProfiles(`<script>AF_initDataCallback({key: 'ds:1', data:[[[`), []);
  assert.deepEqual(extractInitDataBlocks("<html>no data here</html>"), []);
});

test("字符串里的括号不会打断字面量扫描", () => {
  const payload = [[["Title with ] and }", 1]]];
  const html = `<script>AF_initDataCallback({key: 'ds:1', data:${JSON.stringify(payload)}, sideChannel: {}});</script>`;

  const blocks = extractInitDataBlocks(html);
  assert.equal(blocks.length, 1);
  assert.deepEqual(blocks[0], payload);
});
