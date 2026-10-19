/* ============================================================
 * build-legacy-server.js —— 旧入口（保留兼容）
 *
 * 从 v1.3.0 起，服务端统一改成「原生窗口 + Node 运行时」，
 * 打包逻辑合并到 build-server.js：Win7 / Server 2012 R2 / Win10 / Win11
 * 用的是同一份图形界面版本，不再区分「兼容版」与「普通版」。
 *
 * 这里只做转发，老文档/老脚本里的
 *   node scripts/build-legacy-server.js
 * 仍然能正常产出安装包。
 * ============================================================ */
'use strict';
console.log('提示：build-legacy-server.js 已并入 build-server.js（图形界面服务端）。\n');
require('./build-server.js');
