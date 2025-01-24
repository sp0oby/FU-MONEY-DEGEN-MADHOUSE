// utils/sqliteDB.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('../services/logger');

const dbPath = path.resolve(__dirname, '../database.sqlite3');

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        logger.error('Error connecting to SQLite database:', err);
    } else {
        logger.info('Connected to the SQLite database.');
    }
});

// Initialize the users table with eth_balance and usdc_balance
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            telegram_id INTEGER PRIMARY KEY,
            wallet_address TEXT UNIQUE,
            eth_balance REAL DEFAULT 0,
            usdc_balance REAL DEFAULT 0
        )
    `, (err) => {
        if (err) {
            logger.error('Error creating users table:', err);
        } else {
            logger.info('Users table is ready with eth_balance and usdc_balance.');
        }
    });
});

/**
 * Add a new user or update existing user's wallet address.
 * @param {number} telegramId - Telegram user ID.
 * @param {string} walletAddress - User's Ethereum wallet address.
 */
const addOrUpdateUser = (telegramId, walletAddress) => {
    return new Promise((resolve, reject) => {
        const query = `
            INSERT INTO users (telegram_id, wallet_address)
            VALUES (?, ?)
            ON CONFLICT(telegram_id) DO UPDATE SET wallet_address=excluded.wallet_address
        `;
        db.run(query, [telegramId, walletAddress], function(err) {
            if (err) {
                logger.error(`Error adding/updating user ${telegramId}:`, err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

/**
 * Get user by Telegram ID.
 * @param {number} telegramId - Telegram user ID.
 * @returns {Promise<Object>} - User object.
 */
const getUserByTelegramId = (telegramId) => {
    return new Promise((resolve, reject) => {
        const query = `SELECT * FROM users WHERE telegram_id = ?`;
        db.get(query, [telegramId], (err, row) => {
            if (err) {
                logger.error(`Error fetching user ${telegramId}:`, err);
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
};

/**
 * Update user's ETH balance.
 * @param {number} telegramId - Telegram user ID.
 * @param {number} newBalance - New ETH balance.
 */
const updateUserEthBalance = (telegramId, newBalance) => {
    return new Promise((resolve, reject) => {
        const query = `UPDATE users SET eth_balance = ? WHERE telegram_id = ?`;
        db.run(query, [newBalance, telegramId], function(err) {
            if (err) {
                logger.error(`Error updating ETH balance for user ${telegramId}:`, err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

/**
 * Update user's USDC balance.
 * @param {number} telegramId - Telegram user ID.
 * @param {number} newBalance - New USDC balance.
 */
const updateUserUsdcBalance = (telegramId, newBalance) => {
    return new Promise((resolve, reject) => {
        const query = `UPDATE users SET usdc_balance = ? WHERE telegram_id = ?`;
        db.run(query, [newBalance, telegramId], function(err) {
            if (err) {
                logger.error(`Error updating USDC balance for user ${telegramId}:`, err);
                reject(err);
            } else {
                resolve();
            }
        });
    });
};

module.exports = {
    addOrUpdateUser,
    getUserByTelegramId,
    updateUserEthBalance,
    updateUserUsdcBalance,
    db, // Exporting db for leaderboard queries
};
