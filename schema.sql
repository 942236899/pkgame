-- ============================================================
--  找队友扑克 —— MySQL 8.0 建库建表
--  用法：mysql -u root -p < schema.sql
--  （服务器启动时会自愈式执行同样的建表语句，本文件用于手工初始化/迁移）
-- ============================================================

CREATE DATABASE IF NOT EXISTS pkgame
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_general_ci;

USE pkgame;

-- 玩家
CREATE TABLE IF NOT EXISTS player (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  nickname     VARCHAR(32)  NOT NULL,
  avatar       VARCHAR(16)  DEFAULT NULL,
  total_games  INT          NOT NULL DEFAULT 0,
  total_wins   INT          NOT NULL DEFAULT 0,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_nickname (nickname)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 牌局
CREATE TABLE IF NOT EXISTS game (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  room_code    VARCHAR(16)  DEFAULT NULL,
  mode         TINYINT      NOT NULL DEFAULT 2 COMMENT '1=单机 2=联机',
  player_count TINYINT      NOT NULL DEFAULT 4,
  winner_seat  TINYINT      DEFAULT NULL,
  solo_seat    TINYINT      DEFAULT NULL COMMENT '1打3的独狼座位',
  started_at   DATETIME     NOT NULL,
  finished_at  DATETIME     DEFAULT NULL,
  KEY idx_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 每局座位（含队伍，结算后才有意义）
CREATE TABLE IF NOT EXISTS game_seat (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  game_id      BIGINT UNSIGNED NOT NULL,
  seat_no      TINYINT      NOT NULL COMMENT '0-3',
  nickname     VARCHAR(32)  NOT NULL,
  is_ai        TINYINT      NOT NULL DEFAULT 0,
  initial_hand VARCHAR(255) DEFAULT NULL COMMENT '初始13张，如 D3 S5 HK',
  team         TINYINT      DEFAULT NULL COMMENT '0=♦3/♦A队 1=另一队',
  rank_no      TINYINT      DEFAULT NULL COMMENT '名次',
  UNIQUE KEY uk_game_seat (game_id, seat_no),
  KEY idx_game (game_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 逐手出牌记录（复盘）
CREATE TABLE IF NOT EXISTS game_action (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  game_id      BIGINT UNSIGNED NOT NULL,
  seat_no      TINYINT      NOT NULL,
  action       VARCHAR(16)  NOT NULL COMMENT 'play / pass',
  combo_type   VARCHAR(16)  DEFAULT NULL,
  cards        VARCHAR(64)  DEFAULT NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_game (game_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
