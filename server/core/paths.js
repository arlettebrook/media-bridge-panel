'use strict';
/**
 * 项目路径集中定义
 *
 * 各层不再用「相对自己几层」推算目录，避免文件搬家后路径错位。
 * 可用 DATA_DIR 环境变量把运行时数据放到别处（备份/多实例）。
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

module.exports = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR,
  SETTINGS_DIR: path.join(DATA_DIR, 'settings'),
  /** 插件宿主（见 docs/adr/0028）：`plugins/<类型>/<id>/` —— 装在这下面的插件包 + 它自己的 data/。
   * 源实例（猫源包与它的运行目录）现在归**源插件**自己管，就在那个 data/ 里。 */
  PLUGINS_DIR: path.join(DATA_DIR, 'plugins'),
  /** 模板：一份一个文件（站点集合 + 打分过滤参数 + 超时与并发，见 docs/adr/0033）。 */
  TEMPLATES_DIR: path.join(DATA_DIR, 'templates'),
  /** **共享缓存目录**（可随时删掉重建的数据）：聚合线路结果（见 core/cachedb.js + agg/cache.js）。
   * 缓存按"谁用"分家 —— 面板自己用的在这里与 `data/emby/cache.db`，
   * **元数据插件的缓存不在这里**（它自己在 `plugins/<类型>/<id>/data/` 下）。 */
  CACHE_DIR: path.join(DATA_DIR, 'cache'),
  /** 线路结果缓存库：`line_cache`（影视名 + 季集 + 影响结果的参数 → 线路与定位结果，见 agg/cache.js）
   * + `agg_stat`（按插件记的聚合耗时）。放共享缓存目录：读它的有聚合层（web 取详情）
   * 与 emby 层（条目详情 / 播放信息）。⚠️ 旧版那份 `detail.db`（完整快照）已不再读写。 */
  LINES_CACHE_DB: path.join(DATA_DIR, 'cache', 'lines.db'),
  /** emby 模块自己的库（客户端登录账号等；含密码哈希，不要提交/外发） */
  EMBY_DIR: path.join(DATA_DIR, 'emby'),
  EMBY_DB: path.join(DATA_DIR, 'emby', 'emby.db'),
  /** 旧版单文件设置（会被自动搬迁到 settings/ 目录） */
  LEGACY_SETTINGS: path.join(DATA_DIR, 'settings.json'),
};
