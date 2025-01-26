// utils/sqliteDB.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('../services/logger');

// Initialize SQLite Database
const dbPath = path.resolve(__dirname, 'users.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('Error connecting to SQLite database:', err);
  } else {
    logger.info('Connected to SQLite database.');
  }
});

// Initialize Users and Jackpot Tables
const initDB = () => {
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      wallet_address TEXT NOT NULL,
      eth_balance REAL NOT NULL DEFAULT 0,
      usdc_balance REAL NOT NULL DEFAULT 0
    )
  `;

  const createJackpotTable = `
    CREATE TABLE IF NOT EXISTS jackpot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_usdc REAL NOT NULL DEFAULT 0
    )
  `;

  db.serialize(() => {
    db.run(createUsersTable, (err) => {
      if (err) {
        logger.error('Error creating users table:', err);
      } else {
        logger.info('Users table is ready.');
      }
    });

    db.run(createJackpotTable, (err) => {
      if (err) {
        logger.error('Error creating jackpot table:', err);
      } else {
        logger.info('Jackpot table is ready.');
        // Insert initial jackpot entry if not exists
        db.run(
          `INSERT OR IGNORE INTO jackpot (id, total_usdc) VALUES (1, 0)`,
          (err) => {
            if (err) {
              logger.error('Error initializing jackpot pool:', err);
            } else {
              logger.info('Jackpot pool initialized.');
            }
          }
        );
      }
    });
  });
};

initDB();

// Export database and functions
module.exports = {
  db,
  addOrUpdateUser: async (telegramId, walletAddress) => {
    const query = `
      INSERT INTO users (telegram_id, wallet_address, eth_balance, usdc_balance)
      VALUES (?, ?, 0, 0)
      ON CONFLICT(telegram_id) DO UPDATE SET wallet_address = excluded.wallet_address
    `;
    return new Promise((resolve, reject) => {
      db.run(query, [telegramId, walletAddress], function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  },
  getUserByTelegramId: async (telegramId) => {
    const query = `SELECT * FROM users WHERE telegram_id = ?`;
    return new Promise((resolve, reject) => {
      db.get(query, [telegramId], (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  },
  updateUserEthBalance: async (telegramId, newBalance) => {
    const query = `UPDATE users SET eth_balance = ? WHERE telegram_id = ?`;
    return new Promise((resolve, reject) => {
      db.run(query, [newBalance, telegramId], function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  },
  updateUserUsdcBalance: async (telegramId, newBalance) => {
    const query = `UPDATE users SET usdc_balance = ? WHERE telegram_id = ?`;
    return new Promise((resolve, reject) => {
      db.run(query, [newBalance, telegramId], function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  },
  // Jackpot Pool Functions
  getJackpot: async () => {
    const query = `SELECT total_usdc FROM jackpot WHERE id = 1`;
    return new Promise((resolve, reject) => {
      db.get(query, [], (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.total_usdc : 0);
      });
    });
  },
  updateJackpot: async (newTotal) => {
    const query = `UPDATE jackpot SET total_usdc = ? WHERE id = 1`;
    return new Promise((resolve, reject) => {
      db.run(query, [newTotal], function (err) {
        if (err) reject(err);
        else resolve();
      });
    });
  },
};
