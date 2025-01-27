// utils/sqliteDB.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Initialize SQLite database
const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err);
  } else {
    console.log('Connected to SQLite database.');
  }
});

// Create necessary tables if they don't exist
db.serialize(() => {
  // Users table with username
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      wallet_address TEXT NOT NULL,
      eth_balance REAL NOT NULL DEFAULT 0,
      usdc_balance REAL NOT NULL DEFAULT 0,
      last_claim TEXT DEFAULT NULL
    )
  `);

  // Jackpot pool table (single row)
  db.run(`
    CREATE TABLE IF NOT EXISTS jackpot (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      usdc_pool REAL NOT NULL DEFAULT 0
    )
  `);

  // Initialize jackpot pool if not present
  db.get(`SELECT COUNT(*) as count FROM jackpot`, (err, row) => {
    if (err) {
      console.error('Error checking jackpot table:', err);
    } else if (row.count === 0) {
      db.run(`INSERT INTO jackpot (id, usdc_pool) VALUES (1, 0)`);
    }
  });
});

// Export database methods
module.exports = {
  db,

  /**
   * Retrieves a user by their Telegram ID.
   * @param {number} telegramId - The Telegram ID of the user.
   * @returns {Promise<Object>} - Resolves with user object or null.
   */
  getUserByTelegramId: (telegramId) => {
    return new Promise((resolve, reject) => {
      const query = `SELECT * FROM users WHERE telegram_id = ?`;
      db.get(query, [telegramId], (err, row) => {
        if (err) {
          return reject(err);
        }
        resolve(row || null);
      });
    });
  },

  /**
   * Adds a new user or updates their wallet address and username.
   * @param {number} telegramId - The Telegram ID of the user.
   * @param {string} username - The Telegram username of the user.
   * @param {string} walletAddress - The Ethereum wallet address of the user.
   * @returns {Promise<void>}
   */
  addOrUpdateUser: (telegramId, username, walletAddress) => {
    return new Promise((resolve, reject) => {
      const query = `
        INSERT INTO users (telegram_id, username, wallet_address)
        VALUES (?, ?, ?)
        ON CONFLICT(telegram_id) DO UPDATE SET 
          username = excluded.username,
          wallet_address = excluded.wallet_address
      `;
      db.run(query, [telegramId, username, walletAddress], function (err) {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  },

  /**
   * Updates a user's ETH balance.
   * @param {number} telegramId - The Telegram ID of the user.
   * @param {number} newBalance - The new ETH balance.
   * @returns {Promise<void>}
   */
  updateUserEthBalance: (telegramId, newBalance) => {
    return new Promise((resolve, reject) => {
      const query = `UPDATE users SET eth_balance = ? WHERE telegram_id = ?`;
      db.run(query, [newBalance, telegramId], function (err) {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  },

  /**
   * Updates a user's USDC balance.
   * @param {number} telegramId - The Telegram ID of the user.
   * @param {number} newBalance - The new USDC balance.
   * @returns {Promise<void>}
   */
  updateUserUsdcBalance: (telegramId, newBalance) => {
    return new Promise((resolve, reject) => {
      const query = `UPDATE users SET usdc_balance = ? WHERE telegram_id = ?`;
      db.run(query, [newBalance, telegramId], function (err) {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  },

  /**
   * Retrieves the current jackpot pool.
   * @returns {Promise<number>} - Resolves with the jackpot pool amount in USDC.
   */
  getJackpot: () => {
    return new Promise((resolve, reject) => {
      const query = `SELECT usdc_pool FROM jackpot WHERE id = 1`;
      db.get(query, [], (err, row) => {
        if (err) {
          return reject(err);
        }
        resolve(row ? row.usdc_pool : 0);
      });
    });
  },

  /**
   * Updates the jackpot pool.
   * @param {number} newPoolAmount - The new jackpot pool amount in USDC.
   * @returns {Promise<void>}
   */
  updateJackpot: (newPoolAmount) => {
    return new Promise((resolve, reject) => {
      const query = `UPDATE jackpot SET usdc_pool = ? WHERE id = 1`;
      db.run(query, [newPoolAmount], function (err) {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  },
};
