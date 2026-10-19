/* ============================================================
 * db.js —— MySQL 持久化（可选）
 * 只在 config.db.enabled = true 时启用；连不上也不影响游戏进行
 * 数据库：MySQL 8.0，驱动 mysql2（连接池）
 * ============================================================ */
'use strict';

var mysql = null;
try { mysql = require('mysql2/promise'); } catch (e) { mysql = null; }

var pool = null;
var enabled = false;
var lastError = '';

function cfgToOpts(cfg) {
  return {
    host: cfg.host || '127.0.0.1',
    port: Number(cfg.port) || 3306,
    user: cfg.user || 'root',
    password: cfg.password || '',
    database: cfg.database || 'tmh_poker',
    waitForConnections: true,
    connectionLimit: 10,
    charset: 'utf8mb4'
  };
}

/** 测试连接，返回 {ok, msg} */
async function test(cfg) {
  if (!mysql) return { ok: false, msg: 'mysql2 未安装，请先 npm install mysql2' };
  var conn = null;
  try {
    conn = await mysql.createConnection(cfgToOpts(cfg));
    await conn.query('SELECT 1');
    return { ok: true, msg: '连接成功' };
  } catch (e) {
    return { ok: false, msg: e.code ? (e.code + '：' + e.message) : e.message };
  } finally {
    if (conn) { try { await conn.end(); } catch (e) { } }
  }
}

/** 启用并建立连接池（不会抛异常） */
async function enable(cfg) {
  enabled = false;
  lastError = '';
  if (!cfg || !cfg.enabled) return { ok: false, msg: '未启用' };
  if (!mysql) { lastError = 'mysql2 未安装'; return { ok: false, msg: lastError }; }
  try {
    pool = mysql.createPool(cfgToOpts(cfg));
    var r = await pool.query('SELECT 1');
    enabled = true;
    await ensureSchema();
    return { ok: true, msg: '已连接并初始化' };
  } catch (e) {
    pool = null;
    lastError = (e.code ? e.code + '：' : '') + e.message;
    return { ok: false, msg: lastError };
  }
}

var SCHEMA = [
  `CREATE TABLE IF NOT EXISTS player (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    nickname VARCHAR(32) NOT NULL,
    avatar VARCHAR(16) DEFAULT NULL,
    total_games INT NOT NULL DEFAULT 0,
    total_wins INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uk_nickname (nickname)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS game (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_code VARCHAR(16) DEFAULT NULL,
    mode TINYINT NOT NULL DEFAULT 2 COMMENT '1=单机 2=联机',
    player_count TINYINT NOT NULL DEFAULT 4,
    winner_seat TINYINT DEFAULT NULL,
    solo_seat TINYINT DEFAULT NULL,
    started_at DATETIME NOT NULL,
    finished_at DATETIME DEFAULT NULL,
    KEY idx_started (started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS game_seat (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    game_id BIGINT UNSIGNED NOT NULL,
    seat_no TINYINT NOT NULL COMMENT '0-3',
    nickname VARCHAR(32) NOT NULL,
    is_ai TINYINT NOT NULL DEFAULT 0,
    initial_hand VARCHAR(255) DEFAULT NULL COMMENT '初始13张，如 D3,S5',
    team TINYINT DEFAULT NULL COMMENT '0=方块3队 1=方块A队',
    rank_no TINYINT DEFAULT NULL COMMENT '名次',
    UNIQUE KEY uk_game_seat (game_id, seat_no),
    KEY idx_game (game_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS game_action (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    game_id BIGINT UNSIGNED NOT NULL,
    seat_no TINYINT NOT NULL,
    action VARCHAR(16) NOT NULL COMMENT 'play / pass',
    combo_type VARCHAR(16) DEFAULT NULL,
    cards VARCHAR(64) DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_game (game_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];

async function ensureSchema() {
  if (!pool) return;
  for (var i = 0; i < SCHEMA.length; i++) {
    try { await pool.query(SCHEMA[i]); } catch (e) { lastError = e.message; }
  }
}

function status() {
  return { enabled: enabled, error: lastError, driver: !!mysql };
}

/** 一局结束后落库（失败不影响游戏） */
async function saveGame(rec) {
  if (!enabled || !pool) return null;
  try {
    var now = new Date();
    var [r] = await pool.query(
      'INSERT INTO game (room_code, mode, player_count, winner_seat, solo_seat, started_at, finished_at) VALUES (?,?,?,?,?,?,?)',
      [rec.roomCode || null, 2, 4, rec.winnerSeat, rec.soloSeat, rec.startedAt || now, now]
    );
    var gid = r.insertId;
    for (var i = 0; i < rec.seats.length; i++) {
      var s = rec.seats[i];
      await pool.query(
        'INSERT INTO game_seat (game_id, seat_no, nickname, is_ai, initial_hand, team, rank_no) VALUES (?,?,?,?,?,?,?)',
        [gid, i, s.name, s.isAI ? 1 : 0, (s.hand || []).join(' '), s.team === null ? null : s.team, s.place || null]
      );
      if (!s.isAI) {
        await pool.query(
          'INSERT INTO player (nickname, total_games, total_wins) VALUES (?,1,?) ON DUPLICATE KEY UPDATE total_games=total_games+1, total_wins=total_wins+?',
          [s.name, s.place === 1 ? 1 : 0, s.place === 1 ? 1 : 0]
        );
      }
    }
    for (var k = 0; k < (rec.actions || []).length; k++) {
      var a = rec.actions[k];
      await pool.query(
        'INSERT INTO game_action (game_id, seat_no, action, combo_type, cards) VALUES (?,?,?,?,?)',
        [gid, a.seat, a.action, a.combo || null, (a.cards || []).join(' ')]
      );
    }
    return gid;
  } catch (e) {
    lastError = e.message;
    return null;
  }
}

module.exports = { enable: enable, test: test, status: status, saveGame: saveGame };
