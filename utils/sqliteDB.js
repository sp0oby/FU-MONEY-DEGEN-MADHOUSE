// utils/sqliteDB.js

'use strict';

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const logger = require('../services/logger'); // Correct path

const dbPath = path.resolve(__dirname, '../database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    logger.error('Could not connect to database:', err.message);
  } else {
    logger.info('Connected to SQLite database');
  }
});

// Helper function to check if a column exists
const columnExists = (table, column) => {
  return new Promise((resolve, reject) => {
    const query = `PRAGMA table_info(${table})`;
    db.all(query, [], (err, rows) => {
      if (err) {
        logger.error(`Error fetching table info for ${table}:`, err.message);
        return reject(err);
      }
      const exists = rows.some((row) => row.name === column);
      resolve(exists);
    });
  });
};

// Add a column if it doesn't exist
const addColumnIfNotExists = async (table, column, type) => {
  try {
    const exists = await columnExists(table, column);
    if (!exists) {
      const query = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;
      return new Promise((resolve, reject) => {
        db.run(query, [], function (err) {
          if (err) {
            logger.warn(
              `Could not add column '${column}' to table '${table}':`,
              err.message
            );
            return resolve(false);
          }
          logger.info(`Added column '${column}' to table '${table}'.`);
          resolve(true);
        });
      });
    }
    return false;
  } catch (error) {
    logger.error(`Error in addColumnIfNotExists for table '${table}':`, error.message);
    return false;
  }
};

// Initialize the database tables with schema verification
const initDB = async () => {
  const usersTable = `
    CREATE TABLE IF NOT EXISTS users (
      telegram_id INTEGER PRIMARY KEY,
      username TEXT,
      wallet_address TEXT UNIQUE,
      eth_balance REAL DEFAULT 0,
      usdc_balance REAL DEFAULT 0,
      total_bets INTEGER DEFAULT 0,
      total_amount_bet REAL DEFAULT 0,
      total_wins INTEGER DEFAULT 0,
      total_losses INTEGER DEFAULT 0,
      total_usdc_won REAL DEFAULT 0,
      total_usdc_lost REAL DEFAULT 0,
      highest_single_bet REAL DEFAULT 0,
      xp INTEGER DEFAULT 0,
      level INTEGER DEFAULT 1,
      consecutive_login INTEGER DEFAULT 0,
      last_login TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const jackpotTable = `
    CREATE TABLE IF NOT EXISTS jackpot (
      id INTEGER PRIMARY KEY,
      amount REAL DEFAULT 0
    );
  `;

  db.serialize(async () => {
    // Create 'users' table
    db.run(usersTable, [], async (err) => {
      if (err) {
        logger.error('Could not create users table:', err.message);
      } else {
        logger.info('Users table is ready');
        await logTableSchema('users');
        // Define columns with correct types
        const userColumns = {
          telegram_id: 'INTEGER PRIMARY KEY',
          username: 'TEXT',
          wallet_address: 'TEXT UNIQUE',
          eth_balance: 'REAL DEFAULT 0',
          usdc_balance: 'REAL DEFAULT 0',
          total_bets: 'INTEGER DEFAULT 0',
          total_amount_bet: 'REAL DEFAULT 0',
          total_wins: 'INTEGER DEFAULT 0',
          total_losses: 'INTEGER DEFAULT 0',
          total_usdc_won: 'REAL DEFAULT 0',
          total_usdc_lost: 'REAL DEFAULT 0',
          highest_single_bet: 'REAL DEFAULT 0',
          xp: 'INTEGER DEFAULT 0',
          level: 'INTEGER DEFAULT 1',
          consecutive_login: 'INTEGER DEFAULT 0',
          last_login: 'TEXT DEFAULT CURRENT_TIMESTAMP',
        };
        // Ensure all columns exist
        for (const [column, type] of Object.entries(userColumns)) {
          await addColumnIfNotExists('users', column, type);
        }
      }
    });

    // Create 'jackpot' table
    db.run(jackpotTable, [], async (err) => {
      if (err) {
        logger.error('Could not create jackpot table:', err.message);
      } else {
        logger.info('Jackpot table is ready');
        await logTableSchema('jackpot');
        // Ensure 'amount' column exists
        await addColumnIfNotExists('jackpot', 'amount', 'REAL DEFAULT 0');
        // Initialize jackpot with 0 if empty
        db.get('SELECT COUNT(*) as count FROM jackpot', [], (err, row) => {
          if (err) {
            logger.error('Error checking jackpot table:', err.message);
          } else if (row.count === 0) {
            db.run('INSERT INTO jackpot (amount) VALUES (0)', [], (err) => {
              if (err) {
                logger.error('Error initializing jackpot table:', err.message);
              } else {
                logger.info('Jackpot initialized with 0 USDC');
              }
            });
          }
        });
      }
    });
  });
};

// Function to log the current schema of a table
const logTableSchema = async (table) => {
  try {
    const query = `PRAGMA table_info(${table})`;
    db.all(query, [], (err, rows) => {
      if (err) {
        logger.error(`Error fetching table info for '${table}':`, err.message);
      } else {
        const columns = rows.map((row) => `${row.name} (${row.type})`);
        logger.info(`Schema for table '${table}': ${columns.join(', ')}`);
      }
    });
  } catch (error) {
    logger.error(`Error logging schema for table '${table}':`, error.message);
  }
};

// Initialize the database
initDB();

// --------------------- Database Operation Functions ---------------------

/**
 * Adds or updates a user in the database.
 * @param {number} telegramId - The user's Telegram ID.
 * @param {string} username - The user's Telegram username.
 * @param {string} walletAddress - The user's Ethereum wallet address.
 * @returns {Promise<void>}
 */
const addOrUpdateUser = (telegramId, username, walletAddress) => {
  return new Promise((resolve, reject) => {
    const query = `
      INSERT INTO users (telegram_id, username, wallet_address)
      VALUES (?, ?, ?)
      ON CONFLICT(telegram_id) DO UPDATE SET
        username=excluded.username,
        wallet_address=excluded.wallet_address
    `;
    db.run(query, [telegramId, username, walletAddress], function (err) {
      if (err) {
        logger.error(`Error adding/updating user ${telegramId}:`, err.message);
        return reject(err);
      }
      logger.info(`Added/Updated user ${telegramId} in the database.`);
      resolve();
    });
  });
};

/**
 * Retrieves a user by their Telegram ID.
 * @param {number} telegramId - The user's Telegram ID.
 * @returns {Promise<Object|null>} - The user object or null if not found.
 */
const getUserByTelegramId = (telegramId) => {
  return new Promise((resolve, reject) => {
    const query = `SELECT * FROM users WHERE telegram_id = ?`;
    db.get(query, [telegramId], (err, row) => {
      if (err) {
        logger.error(`Error fetching user ${telegramId}:`, err.message);
        return reject(err);
      }
      resolve(row || null);
    });
  });
};

/**
 * Updates a user's ETH balance.
 * @param {number} telegramId - The user's Telegram ID.
 * @param {number} newBalance - The new ETH balance.
 * @returns {Promise<void>}
 */
const updateUserEthBalance = (telegramId, newBalance) => {
  return new Promise((resolve, reject) => {
    const query = `UPDATE users SET eth_balance = ? WHERE telegram_id = ?`;
    db.run(query, [newBalance, telegramId], function (err) {
      if (err) {
        logger.error(`Error updating ETH balance for user ${telegramId}:`, err.message);
        return reject(err);
      }
      logger.info(`Updated ETH balance for user ${telegramId} to ${newBalance} ETH.`);
      resolve();
    });
  });
};

/**
 * Updates a user's USDC balance.
 * @param {number} telegramId - The user's Telegram ID.
 * @param {number} newBalance - The new USDC balance.
 * @returns {Promise<void>}
 */
const updateUserUsdcBalance = (telegramId, newBalance) => {
  return new Promise((resolve, reject) => {
    const query = `UPDATE users SET usdc_balance = ? WHERE telegram_id = ?`;
    db.run(query, [newBalance, telegramId], function (err) {
      if (err) {
        logger.error(`Error updating USDC balance for user ${telegramId}:`, err.message);
        return reject(err);
      }
      logger.info(`Updated USDC balance for user ${telegramId} to ${newBalance} USDC.`);
      resolve();
    });
  });
};

/**
 * Updates user statistics after a bet.
 * @param {number} telegramId - The user's Telegram ID.
 * @param {number} betAmount - The amount bet.
 * @param {boolean} isWin - Whether the bet was a win.
 * @param {number} payout - The payout amount (0 if loss).
 * @returns {Promise<void>}
 */
const updateUserStatsAfterBet = (telegramId, betAmount, isWin, payout) => {
  return new Promise((resolve, reject) => {
    logger.info(
      `updateUserStatsAfterBet called for user ${telegramId}: Bet Amount=${betAmount}, IsWin=${isWin}, Payout=${payout}`
    );
    const query = `
      UPDATE users
      SET
        total_bets = total_bets + 1,
        total_amount_bet = total_amount_bet + ?,
        total_wins = total_wins + ?,
        total_losses = total_losses + ?,
        total_usdc_won = total_usdc_won + ?,
        total_usdc_lost = total_usdc_lost + ?,
        highest_single_bet = CASE
          WHEN ? > highest_single_bet THEN ?
          ELSE highest_single_bet
        END
      WHERE telegram_id = ?
    `;
    db.run(
      query,
      [
        betAmount, // total_amount_bet increment
        isWin ? 1 : 0, // total_wins increment
        isWin ? 0 : 1, // total_losses increment
        isWin ? payout : 0, // total_usdc_won increment
        isWin ? 0 : betAmount, // total_usdc_lost increment
        betAmount, // for highest_single_bet comparison
        betAmount, // for highest_single_bet update
        telegramId, // WHERE clause
      ],
      function (err) {
        if (err) {
          logger.error(`Error updating stats for user ${telegramId}:`, err.message);
          return reject(err);
        }
        logger.info(`Successfully updated stats for user ${telegramId}.`);

        // Fetch and log updated stats
        const selectQuery = `
          SELECT total_bets, total_wins, total_usdc_won
          FROM users
          WHERE telegram_id = ?
        `;
        db.get(selectQuery, [telegramId], (err, row) => {
          if (err) {
            logger.error(`Error fetching updated stats for user ${telegramId}:`, err.message);
            return reject(err);
          }
          logger.info(
            `Updated stats for user ${telegramId}: Bets=${row.total_bets}, Wins=${row.total_wins}, USDC Won=${row.total_usdc_won}`
          );
          resolve();
        });
      }
    );
  });
};

/**
 * Adds XP to a user and handles level-ups if necessary.
 * @param {number} telegramId - The user's Telegram ID.
 * @param {number} xp - The amount of XP to add.
 * @returns {Promise<{newXP: number, newLevel: number, levelUp: boolean}>}
 */
const addUserXP = (telegramId, xp) => {
  return new Promise(async (resolve, reject) => {
    try {
      const user = await getUserByTelegramId(telegramId);
      if (!user) {
        return reject(new Error('User not found'));
      }

      let newXP = user.xp + xp;
      let newLevel = user.level;
      let levelUp = false;

      // Check for level-ups based on non-linear thresholds
      while (newXP >= getXPForNextLevel(newLevel)) {
        newXP -= getXPForNextLevel(newLevel);
        newLevel += 1;
        levelUp = true;
      }

      const updateQuery = `UPDATE users SET xp = ?, level = ? WHERE telegram_id = ?`;
      db.run(updateQuery, [newXP, newLevel, telegramId], function (err) {
        if (err) {
          logger.error(`Error updating XP and level for user ${telegramId}:`, err.message);
          return reject(err);
        }
        logger.info(`Updated XP and level for user ${telegramId}: XP=${newXP}, Level=${newLevel}`);
        resolve({ newXP, newLevel, levelUp });
      });
    } catch (error) {
      logger.error(`Error in addUserXP for user ${telegramId}:`, error.message);
      reject(error);
    }
  });
};

/**
 * Calculates the XP required for the next level based on current level.
 * @param {number} currentLevel - The user's current level.
 * @returns {number} - The XP required for the next level.
 */
const getXPForNextLevel = (currentLevel) => {
  // Example: Exponential progression
  // XP required for next level = 100 * (1.5)^(currentLevel - 1)
  return Math.floor(100 * Math.pow(1.5, currentLevel - 1));
};

/**
 * Retrieves the top users based on the specified criteria.
 * @param {string} criteria - The leaderboard criteria ('balances', 'winners', 'bettors', 'winrates').
 * @param {number} limit - The number of top users to retrieve.
 * @returns {Promise<Array>} - An array of top users.
 */
const getTopUsers = (criteria, limit = 10) => {
  return new Promise((resolve, reject) => {
    let query = '';
    switch (criteria) {
      case 'balances':
        query = `
          SELECT username, usdc_balance, eth_balance, level
          FROM users
          ORDER BY usdc_balance DESC, eth_balance DESC
          LIMIT ?
        `;
        break;
      case 'winners':
        query = `
          SELECT username, total_usdc_won, level
          FROM users
          ORDER BY total_usdc_won DESC
          LIMIT ?
        `;
        break;
      case 'bettors':
        query = `
          SELECT username, total_bets, level
          FROM users
          ORDER BY total_bets DESC
          LIMIT ?
        `;
        break;
      case 'winrates':
        query = `
          SELECT username, 
                 (CAST(total_wins AS FLOAT) / CAST(total_bets AS FLOAT)) * 100 AS win_rate,
                 level
          FROM users
          WHERE total_bets >= 10
          ORDER BY win_rate DESC
          LIMIT ?
        `;
        break;
      default:
        return reject(new Error('Invalid leaderboard criteria.'));
    }

    logger.info(`Fetching top ${limit} users for criteria: ${criteria}`);

    db.all(query, [limit], (err, rows) => {
      if (err) {
        logger.error(`Error fetching top users for criteria '${criteria}':`, err.message);
        return reject(err);
      }
      resolve(rows);
    });
  });
};

/**
 * Retrieves a user's rank based on the specified leaderboard criteria.
 * @param {string} criteria - The leaderboard criteria ('balances', 'winners', 'bettors', 'winrates').
 * @param {number} telegramId - The user's Telegram ID.
 * @returns {Promise<number|null>} - The user's rank or null if not ranked.
 */
const getUserRank = (criteria, telegramId) => {
  return new Promise((resolve, reject) => {
    let query = '';
    switch (criteria) {
      case 'balances':
        query = `
          SELECT COUNT(*) + 1 AS rank
          FROM users
          WHERE usdc_balance > (
            SELECT usdc_balance FROM users WHERE telegram_id = ?
          )
          OR (usdc_balance = (
            SELECT usdc_balance FROM users WHERE telegram_id = ?
          ) AND eth_balance > (
            SELECT eth_balance FROM users WHERE telegram_id = ?
          ))
        `;
        break;
      case 'winners':
        query = `
          SELECT COUNT(*) + 1 AS rank
          FROM users
          WHERE total_usdc_won > (
            SELECT total_usdc_won FROM users WHERE telegram_id = ?
          )
        `;
        break;
      case 'bettors':
        query = `
          SELECT COUNT(*) + 1 AS rank
          FROM users
          WHERE total_bets > (
            SELECT total_bets FROM users WHERE telegram_id = ?
          )
        `;
        break;
      case 'winrates':
        query = `
          SELECT COUNT(*) + 1 AS rank
          FROM users
          WHERE (CAST(total_wins AS FLOAT) / CAST(total_bets AS FLOAT)) * 100 > (
            SELECT (CAST(total_wins AS FLOAT) / CAST(total_bets AS FLOAT)) * 100 FROM users WHERE telegram_id = ?
          )
          AND total_bets >= 10
        `;
        break;
      default:
        return reject(new Error('Invalid leaderboard criteria.'));
    }

    logger.info(`Fetching rank for user ${telegramId} in criteria: ${criteria}`);

    // For 'balances', pass telegramId three times
    // For others, pass it once
    let params = [];
    if (criteria === 'balances') {
      params = [telegramId, telegramId, telegramId];
    } else {
      params = [telegramId];
    }

    db.get(query, params, (err, row) => {
      if (err) {
        logger.error(
          `Error fetching rank for user ${telegramId} in criteria '${criteria}':`,
          err.message
        );
        return reject(err);
      }
      resolve(row ? row.rank : null);
    });
  });
};

/**
 * Retrieves the current jackpot amount.
 * @returns {Promise<number>} - The current jackpot amount in USDC.
 */
const getJackpot = () => {
  return new Promise((resolve, reject) => {
    const query = `SELECT amount FROM jackpot WHERE id = 1`;
    db.get(query, [], (err, row) => {
      if (err) {
        logger.error('Error fetching jackpot:', err.message);
        return reject(err);
      }
      resolve(row ? row.amount : 0);
    });
  });
};

/**
 * Updates the jackpot amount.
 * @param {number} newAmount - The new jackpot amount in USDC.
 * @returns {Promise<void>}
 */
const updateJackpot = (newAmount) => {
  return new Promise((resolve, reject) => {
    const query = `UPDATE jackpot SET amount = ? WHERE id = 1`;
    db.run(query, [newAmount], function (err) {
      if (err) {
        logger.error('Error updating jackpot:', err.message);
        return reject(err);
      }
      logger.info(`Updated jackpot amount to ${newAmount} USDC.`);
      resolve();
    });
  });
};

module.exports = {
  addOrUpdateUser,
  getUserByTelegramId,
  updateUserEthBalance,
  updateUserUsdcBalance,
  updateUserStatsAfterBet,
  getTopUsers,
  getUserRank,
  addUserXP,
  getXPForNextLevel,
  getJackpot,
  updateJackpot,
  db, // Exporting db for deposit monitoring
};
