// index.js
'use strict';

require('dotenv').config();
const express = require('express');
const { Telegraf, session, Scenes, Markup } = require('telegraf');
const logger = require('./services/logger'); // Correct path
const sqliteDB = require('./utils/sqliteDB'); // Correct path
const { ethers } = require('ethers');
const crypto = require('crypto'); // Import crypto module

// --------------------- Bot Initialization ---------------------
const bot = new Telegraf(process.env.BOT_TOKEN);

// Enable session middleware
bot.use(session());

// --------------------- Initialize Provider and Wallet ---------------------

// Team Wallet
const TEAM_WALLET_ADDRESS = process.env.TEAM_WALLET_ADDRESS;

// Initialize Provider for Sepolia Testnet
const provider = new ethers.providers.InfuraProvider(
  'sepolia',
  process.env.INFURA_PROJECT_ID
);

// Initialize Pool Wallet (Used for both Deposits and Withdrawals)
const poolWallet = new ethers.Wallet(process.env.POOL_PRIVATE_KEY, provider);

// Initialize USDC Contract with Pool Wallet
const usdcAbi = [
  'function transfer(address to, uint256 value) public returns (bool)',
  'function balanceOf(address account) public view returns (uint256)',
];
const usdcContract = new ethers.Contract(
  process.env.USDC_CONTRACT_ADDRESS,
  usdcAbi,
  poolWallet
);

// --------------------- Helper Functions ---------------------

/**
 * Validates if the input string is a valid positive number.
 * @param {string} input - The input string to validate.
 * @returns {boolean} - Returns true if valid, else false.
 */
const isValidAmount = (input) => {
  const amount = Number(input);
  return !isNaN(amount) && amount > 0 && /^\d+(\.\d+)?$/.test(input);
};

/**
 * Generates a secure random number between 0 and 1 using user-provided entropy.
 * @param {string} userEntropy - User-specific entropy (e.g., wallet address).
 * @returns {number} - A secure random number between 0 (inclusive) and 1 (exclusive).
 */
const generateSecureRandom = (userEntropy) => {
  const timestamp = Date.now().toString();
  const randomBytes = crypto.randomBytes(16).toString('hex');
  const seed = crypto
    .createHash('sha256')
    .update(userEntropy + timestamp + randomBytes)
    .digest('hex');

  // Convert the first 8 characters of the hash to a number
  const hashSlice = seed.slice(0, 8);
  const num = parseInt(hashSlice, 16);

  // Normalize to [0,1)
  return num / 0xFFFFFFFF;
};

/**
 * Creates a visual progress bar based on current and required XP.
 * @param {number} current - Current XP.
 * @param {number} required - XP required for next level.
 * @returns {string} - A text-based progress bar.
 */
const createProgressBar = (current, required) => {
  const totalBars = 20;
  const filledBars = Math.round((current / required) * totalBars);
  const emptyBars = totalBars - filledBars;
  return `${'█'.repeat(filledBars)}${'░'.repeat(emptyBars)}`;
};

/**
 * Retrieves the badge corresponding to a user's level.
 * @param {number} level - The user's current level.
 * @returns {string} - The badge emoji and name.
 */
const getBadge = (level) => {
  const badges = {
    1: '🟢 Beginner',
    2: '🔵 Intermediate',
    3: '🟣 Advanced',
    4: '🟠 Expert',
    5: '⭐ Master',
    6: '🎖️ Elite',
    7: '🏅 Champion',
    8: '🏆 Legend',
    9: '🥇 Hero',
    10: '👑 King/Queen',
    // ... Continue as needed
  };
  return badges[level] || '✨ Novice';
};

/**
 * Checks if the jackpot pool has sufficient USDC for rewards.
 * @param {number} requiredAmount - The amount of USDC required.
 * @returns {Promise<boolean>} - True if sufficient, else false.
 */
const isPoolFunded = async (requiredAmount) => {
  const currentJackpot = await sqliteDB.getJackpot();
  return currentJackpot >= requiredAmount;
};

/**
 * Applies rewards based on the user's new level.
 * @param {Object} telegram - The telegram object to send messages.
 * @param {number} telegramId - The user's Telegram ID.
 * @param {number} newLevel - The user's new level.
 */
const applyLevelRewards = async (telegram, telegramId, newLevel) => {
  const reward = levels[newLevel]?.reward || '';

  if (reward.includes('USDC')) {
    const bonusUSDC = 10; // Fixed bonus

    const poolFunded = await isPoolFunded(bonusUSDC);
    if (!poolFunded) {
      await telegram.sendMessage(
        telegramId,
        '⚠️ *Insufficient funds in the pool to grant your reward. Please try again later.*',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    // Credit the user's USDC balance
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    const updatedUsdcBalance = parseFloat((user.usdc_balance + bonusUSDC).toFixed(6));
    await sqliteDB.updateUserUsdcBalance(telegramId, updatedUsdcBalance);

    // Deduct from the pool
    const newJackpot = parseFloat((await sqliteDB.getJackpot() - bonusUSDC).toFixed(6));
    await sqliteDB.updateJackpot(newJackpot);

    // Notify the user
    await telegram.sendMessage(
      telegramId,
      `💰 You've received a bonus of *${bonusUSDC} USDC*!`,
      { parse_mode: 'Markdown' }
    );
    logger.info(`Granted bonus of ${bonusUSDC} USDC to user ${telegramId}.`);
  } else {
    await telegram.sendMessage(
      telegramId,
      '🎉 *Congratulations on leveling up!*',
      { parse_mode: 'Markdown' }
    );
  }
};

/**
 * Handles callback queries by answering them immediately and then executing a provided handler.
 * @param {Function} handler - The async function to execute after answering the callback.
 * @returns {Function} - An async function compatible with Telegraf's callback_query handler.
 */
const handleCallbackQuery = (handler) => {
  return async (ctx) => {
    const data = ctx.callbackQuery.data;
    const telegramId = ctx.from.id;

    logger.info(`Callback Query: ${data} from Telegram ID ${telegramId}`);

    // **Immediately answer the callback query**
    try {
      await ctx.answerCbQuery();
    } catch (error) {
      logger.error(`Failed to answer callback query: ${error.message}`);
      return; // Exit if unable to answer
    }

    // **Execute the provided handler**
    try {
      await handler(ctx, data);
    } catch (error) {
      logger.error(`Error handling callback query '${data}' for Telegram ID ${telegramId}:`, error.message);
      await ctx.reply(
        '❌ An error occurred while processing your request. Please try again later.'
      );
    }
  };
};

/**
 * Sends the main menu to the user with various options.
 * @param {Telegraf.Context} ctx - The Telegram context.
 */
const sendMainMenu = async (ctx) => {
  const mainMenuMessage = `
🏠 *Main Menu*

Try your luck for the **JACKPOT** after every win (Bet 100 USDC)!

Choose an option below:
  `;

  const inlineButtons = Markup.inlineKeyboard([
    [
      Markup.button.callback('🎰 Play Degen Madhouse', 'play'),
      Markup.button.callback('💵 Deposit Funds', 'deposit'),
    ],
    [
      Markup.button.callback('💰 Withdraw Funds', 'withdraw'),
      Markup.button.callback('📊 View Balance', 'balance'),
    ],
    [
      Markup.button.callback('🏆 Leaderboard', 'leaderboard'),
      Markup.button.callback('❓ Help', 'help'),
    ],
    [
      Markup.button.callback('💎 Jackpot Pool', 'view_pool'), // Added 'Jackpot Pool'
      Markup.button.callback('📈 Check Level', 'level'), // Added 'Check Level'
    ],
  ]);

  logger.info(`Sending Main Menu to Telegram ID ${ctx.from.id}`);
  await ctx.reply(mainMenuMessage, {
    parse_mode: 'Markdown',
    ...inlineButtons,
  });
};

// --------------------- Level Configurations ---------------------

// Define level configurations with only 10 USDC reward
const levels = {
  1: { xp: 0, reward: 'Welcome Bonus: 10 USDC' },
  2: { xp: 100, reward: 'Level Up Bonus: 10 USDC' },
  3: { xp: 300, reward: 'Level Up Bonus: 10 USDC' },
  4: { xp: 600, reward: 'Level Up Bonus: 10 USDC' },
  5: { xp: 1000, reward: 'Level Up Bonus: 10 USDC' },
  6: { xp: 1500, reward: 'Level Up Bonus: 10 USDC' },
  7: { xp: 2100, reward: 'Level Up Bonus: 10 USDC' },
  8: { xp: 2800, reward: 'Level Up Bonus: 10 USDC' },
  9: { xp: 3600, reward: 'Level Up Bonus: 10 USDC' },
  10: { xp: 4500, reward: 'Level Up Bonus: 10 USDC' },
  // Add more levels as needed
};

// --------------------- HandleBet Function ---------------------

/**
 * Handles the betting logic for the Play Slots feature with secure RNG and XP integration.
 * @param {Telegraf.Context} ctx - The Telegram context.
 * @param {number} betAmount - The amount of USDC being bet.
 */
const handleBet = async (ctx, betAmount) => {
  const telegramId = ctx.from.id;
  logger.info(`Handling bet: ${betAmount} USDC for Telegram ID ${telegramId}`);
  try {
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(
        '❌ You are not registered. Please use /start to register your wallet address.'
      );
      return;
    }

    if (user.usdc_balance < betAmount) {
      await ctx.reply('⚠️ *Insufficient USDC balance.* Please deposit USDC to play.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    // Deduct bet amount from user's USDC balance
    const newUsdcBalance = parseFloat((user.usdc_balance - betAmount).toFixed(6));
    await sqliteDB.updateUserUsdcBalance(telegramId, newUsdcBalance);
    logger.info(
      `User ${telegramId} placed a bet of ${betAmount} USDC. New USDC balance: ${newUsdcBalance} USDC`
    );

    // Add bet amount to the jackpot pool
    const currentJackpot = await sqliteDB.getJackpot();
    const newJackpot = parseFloat((currentJackpot + betAmount).toFixed(6));
    await sqliteDB.updateJackpot(newJackpot);
    logger.info(`Updated jackpot pool: ${newJackpot} USDC`);

    // Generate secure random number using user's wallet address as entropy
    const rng = generateSecureRandom(user.wallet_address);
    logger.info(`Generated RNG for user ${telegramId}: ${rng}`);

    // Determine result based on RNG
    const result = rng < 0.25 ? 'win' : 'lose'; // 25% chance to win
    logger.info(`User ${telegramId} RNG: ${rng}, Result: ${result}`);

    // Log the seed (for verifiability purposes)
    const seed = crypto
      .createHash('sha256')
      .update(user.wallet_address + Date.now().toString() + crypto.randomBytes(16))
      .digest('hex');
    logger.info(`Seed for user ${telegramId}: ${seed}`);

    if (result === 'win') {
      // Random dancing GIF array
      const dancingGifs = [
        'https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExOXBhdW9pMzloNG10czJtODhsbWJlMmliMGM4bWwycDRzZnRydXVwYiZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/LCdPNT81vlv3y/giphy.gif',
        'https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExeDFoY3N0M242bXFkcnJqanIwNDEydms3eXViMzF3YzZldzJ0aHduaCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/XGP7mf38Vggik/giphy.gif',
        'https://media4.giphy.com/media/v1.Y2lkPTc5MGI3NjExMjdtaTUwMWFodmRhaW4weXpraHE3anF4bnN4NWk2ZGxlOXNqZnp6dCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/d2bOZ4zvrpTGM/giphy.gif',
        'https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExbnhkbGNleDZtcmF6bHRuZTA3OXl2MmR1MXlrbDk2NzcxMGFlbmQwMCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/yayaHpsS5xTQBGlKKh/giphy.gif',
        'https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExNXlucnAzajFpajU5eWpzNWUxeTV6bnFtNG1uOGhtNHJpa3dlZXdjcSZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/D0JwpqRpIghqK7Uz8F/giphy.gif',
        'https://media2.giphy.com/media/v1.Y2lkPTc5MGI3NjExMjdtaTUwMWFodmRhaW4weXpraHE3anF4bnN4NWk2ZGxlOXNqZnp6dCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/XIBJDxVKgGvuINP7W0/giphy.gif',
      ];
      const randomGif =
        dancingGifs[Math.floor(Math.random() * dancingGifs.length)];

      // New payout logic (3.6x for 10% house edge)
      const payout = betAmount * 3.6;
      const updatedUsdcBalance = parseFloat(
        (newUsdcBalance + payout).toFixed(6)
      );
      await sqliteDB.updateUserUsdcBalance(telegramId, updatedUsdcBalance);

      // Deduct payout from jackpot pool
      const updatedJackpotAfterPayout = parseFloat(
        (newJackpot - payout).toFixed(6)
      );
      await sqliteDB.updateJackpot(updatedJackpotAfterPayout);
      logger.info(
        `Deducted ${payout} USDC from jackpot pool. New jackpot pool: ${updatedJackpotAfterPayout} USDC`
      );

      // Send dancing GIF
      await ctx.replyWithAnimation(randomGif); // Dancing GIF

      // Send win message
      await ctx.reply(
        `🎉 *You won!*\n\nPayout: *${payout} USDC* has been added to your in-game balance.\n\n*Your new USDC balance:* ${updatedUsdcBalance} USDC\n\n*RNG Seed:* \`${seed}\`\n*RNG Value:* \`${rng}\`\n\nTo withdraw your winnings, use the /withdraw command.`,
        { parse_mode: 'Markdown' }
      );
      logger.info(
        `User ${telegramId} won ${payout} USDC. New USDC balance: ${updatedUsdcBalance} USDC`
      );

      // *** JACKPOT Offer if user has >= 100 USDC ***
      if (updatedUsdcBalance >= 100) {
        // Transition to 'jackpot_scene' to handle the offer
        await ctx.scene.enter('jackpot_scene');
        return; // Exit the function to wait for user action in jackpot_scene
      }

      // Award XP for winning
      await sqliteDB
        .addUserXP(telegramId, 20)
        .then(async ({ newXP, newLevel, levelUp }) => {
          if (levelUp) {
            await ctx.replyWithMarkdown(
              `🎉 *Level Up!* You've reached *Level ${newLevel}*. ${
                levels[newLevel]?.reward || 'Congratulations!'
              }`
            );
            await applyLevelRewards(ctx.telegram, telegramId, newLevel);
          } else {
            await ctx.replyWithMarkdown(
              `📈 *XP Earned:* 20 XP\n*Total XP:* ${newXP} XP`
            );
          }
        });

      // *** Single Update to User Statistics for a Win ***
      await sqliteDB.updateUserStatsAfterBet(
        telegramId,
        betAmount,
        true, // isWin
        payout
      );
      logger.info(
        `Updated user statistics for Telegram ID ${telegramId} with a win.`
      );

      // If no jackpot offer, just leave scene & show main menu
      await ctx.scene.leave();
      await sendMainMenu(ctx);
    } else {
      // Lost bet

      // Award XP for losing
      await sqliteDB
        .addUserXP(telegramId, 5)
        .then(async ({ newXP, newLevel, levelUp }) => {
          if (levelUp) {
            await ctx.replyWithMarkdown(
              `🎉 *Level Up!* You've reached *Level ${newLevel}*. ${
                levels[newLevel]?.reward || 'Congratulations!'
              }`
            );
            await applyLevelRewards(ctx.telegram, telegramId, newLevel);
          } else {
            await ctx.replyWithMarkdown(
              `📈 *XP Earned:* 5 XP\n*Total XP:* ${newXP} XP`
            );
          }
        });

      await ctx.reply(
        `😞 *You lost ${betAmount} USDC.*\n\n*Your new USDC balance:* ${newUsdcBalance} USDC\n\n*RNG Seed:* \`${seed}\`\n*RNG Value:* \`${rng}\``,
        { parse_mode: 'Markdown' }
      );
      logger.info(
        `User ${telegramId} lost ${betAmount} USDC. New USDC balance: ${newUsdcBalance} USDC`
      );

      // *** Single Update to User Statistics for a Loss ***
      await sqliteDB.updateUserStatsAfterBet(
        telegramId,
        betAmount,
        false, // isWin
        0 // payout
      );
      logger.info(
        `Updated user statistics for Telegram ID ${telegramId} with a loss.`
      );

      // If no jackpot offer, just leave scene & show main menu
      if (!ctx.scene.current) {
        await ctx.scene.leave();
        await sendMainMenu(ctx);
      }
    }
  } catch (error) {
    await ctx.reply('❌ Error processing your bet. Please try again later.');
    logger.error(`Error processing USDC bet for Telegram ID ${telegramId}:`, error.message);
  }
};

// --------------------- Scenes ---------------------

// Registration Scene
const registrationScene = new Scenes.BaseScene('registration');
registrationScene.enter((ctx) => {
  logger.info(`Entering registration scene for Telegram ID ${ctx.from.id}`);

  const welcomeMessage = `
👋 *Welcome to FU MONEY DEGEN MADHOUSE!*

*TLDR; PROVIDE YOUR ETHEREUM ADDRESS TO START GAMBLING NOW.(BASE)*

🎰 *About the Game:*
Use your FU MONEY tokens to place bets and win big. Every winning bet brings you closer to the *Jackpot Pool*, where massive rewards await the lucky few.

🔗 *Open Source Project by FU STUDIOS:* [github.com/sp0oby/fu-money-mania](https://github.com/sp0oby/fu-money-mania)

💰 *How It Works:*
1. **Register:** Provide your Ethereum wallet address to get started (Base)
2. **Deposit:** Add FU MONEY and ETH (to pay for withdraw gas fee) to your account securely.
3. **Play:** Choose your bet amount and play.
4. **Win:** Earn FU MONEY based on your bet. High-rollers can participate in *Jackpot Bets* for a chance to win the entire pool!

*Don't have any FU MONEY? Buy on Base: app.uniswap.org/swap?outputCurrency=0x8f4E4221ba88D4E9Bb76ECFB91d7C5ce08D7d5b9&chain=base*

🔥 *Special Features:*
- **Jackpot Pool:** Accumulate 10,000 FU MONEY or more to enter the Jackpot Bet with a chance to win the entire pool.
- **Leaderboards:** Compete with other players and climb the rankings based on your FU MONEY and ETH balances.
- **Secure & Transparent:** All transactions are handled securely on the Sepolia Testnet.

🔐 *Secure Registration:*
Please send your valid Ethereum wallet address below to ensure all your winnings are safely transferred to you. Double-check your address to avoid any loss of funds.
Your private keys are never shared or stored. It is the safest and most secure way to play on-chain.

💡 *Need Help?* Use the /help command at any time to see available commands and get assistance.

🕹️ *Ready to Play?* Let's get you registered and spinning those reels!
  `;

  ctx.reply(welcomeMessage, { parse_mode: 'Markdown' });
});
registrationScene.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const walletAddress = ctx.message.text.trim();
  const username = ctx.from.username || `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();

  // Validate Ethereum address before updating the user
  if (!ethers.utils.isAddress(walletAddress)) {
    await ctx.reply('❌ *Invalid Ethereum address.* Please send a valid address.', {
      parse_mode: 'Markdown',
    });
    return;
  }

  try {
    await sqliteDB.addOrUpdateUser(telegramId, username, walletAddress);
    await ctx.reply(
      '✅ *Registration successful!*\n\nYou can now use the bot commands. Use /help to see available commands.',
      { parse_mode: 'Markdown' }
    );
    logger.info(
      `User registered: Telegram ID ${telegramId}, Username ${username}, Wallet Address ${walletAddress}`
    );
    ctx.scene.leave();
    await sendMainMenu(ctx);
  } catch (error) {
    await ctx.reply('❌ An error occurred during registration. Please try again.');
    logger.error(`Error registering user ${telegramId}:`, error.message);
    ctx.scene.leave();
  }
});
registrationScene.on('message', (ctx) => {
  ctx.reply('❌ Please send a valid Ethereum wallet address to register.');
});

// Play Scene
const playScene = new Scenes.BaseScene('play_scene');
playScene.enter((ctx) => {
  logger.info(`Entering play_scene for Telegram ID ${ctx.from.id}`);
  ctx.reply('🎰 *Play Degen Madhouse*\n\nChoose your bet amount:', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('💵 5 USDC', 'bet_usdc_5'),
        Markup.button.callback('💵 10 USDC', 'bet_usdc_10'),
      ],
      [
        Markup.button.callback('💵 100 USDC', 'bet_usdc_100'),
        Markup.button.callback('💵 1,000 USDC', 'bet_usdc_1000'),
      ],
      [
        Markup.button.callback('💵 10,000 USDC', 'bet_usdc_10000'),
        Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu'),
      ],
    ]),
  });
});

// Refactored Callback Query Handler for Play Scene using Helper Function
playScene.on(
  'callback_query',
  handleCallbackQuery(async (ctx, data) => {
    switch (data) {
      case 'bet_usdc_5':
        await handleBet(ctx, 5);
        break;
      case 'bet_usdc_10':
        await handleBet(ctx, 10);
        break;
      case 'bet_usdc_100':
        await handleBet(ctx, 100);
        break;
      case 'bet_usdc_1000':
        await handleBet(ctx, 1000);
        break;
      case 'bet_usdc_10000':
        await handleBet(ctx, 10000);
        break;
      case 'main_menu':
        await ctx.scene.leave();
        await sendMainMenu(ctx);
        break;
      default:
        await ctx.reply('⚠️ *Unknown action in Play Degen Madhouse.* Please try again.', {
          parse_mode: 'Markdown',
        });
    }
  })
);

// Deposit Scene
const depositScene = new Scenes.BaseScene('deposit_scene');
depositScene.enter(async (ctx) => {
  logger.info(`Entering deposit_scene for Telegram ID ${ctx.from.id}`);
  const poolAddress = process.env.POOL_ADDRESS;
  const depositMessage = `📥 *Depositing Funds (Base)*\n\nPlease transfer your desired amount to the pool address below:\n\n- *USDC:* ${poolAddress}\n- *ETH:* ${poolAddress}\n\nYour balances will update automatically upon successful deposits.`;

  await ctx.reply(depositMessage, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('🔄 Refresh Deposit Instructions', 'deposit'),
        Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu'),
      ],
    ]),
  });
});

// Refactored Callback Query Handler for Deposit Scene using Helper Function
depositScene.on(
  'callback_query',
  handleCallbackQuery(async (ctx, data) => {
    switch (data) {
      case 'deposit': {
        const poolAddress = process.env.POOL_ADDRESS;
        const updatedDepositMessage = `📥 *Depositing Funds (Base)*\n\nPlease transfer your desired amount to the pool address below:\n\n- *USDC:* ${poolAddress}\n- *ETH:* ${poolAddress}\n\nYour balances will update automatically upon successful deposits.`;
        await ctx.reply(updatedDepositMessage, { parse_mode: 'Markdown' });
        break;
      }
      case 'main_menu':
        await ctx.scene.leave();
        await sendMainMenu(ctx);
        break;
      default:
        await ctx.reply('⚠️ *Unknown action in Deposit Funds.* Please try again.', {
          parse_mode: 'Markdown',
        });
    }
  })
);

// Leaderboard Scene
const leaderboardScene = new Scenes.BaseScene('leaderboard_scene');
leaderboardScene.enter(async (ctx) => {
  logger.info(`Entering leaderboard_scene for Telegram ID ${ctx.from.id}`);
  const leaderboardOptions = `
🏆 *Leaderboard Categories:*
Choose a category to view the leaderboard:
  `;

  await ctx.reply(leaderboardOptions, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔝 Top Balances', 'leaderboard_balances')],
      [Markup.button.callback('🥇 Top Winners', 'leaderboard_winners')],
      [Markup.button.callback('💰 Top Bettors', 'leaderboard_bettors')],
      [Markup.button.callback('📈 Best Win Rates', 'leaderboard_winrates')],
      [Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu')],
    ]),
  });
});

// Refactored Callback Query Handler for Leaderboard Scene using Helper Function
leaderboardScene.on(
  'callback_query',
  handleCallbackQuery(async (ctx, data) => {
    const telegramId = ctx.from.id;

    switch (data) {
      case 'leaderboard_balances':
        await displayLeaderboard(ctx, 'balances');
        break;
      case 'leaderboard_winners':
        await displayLeaderboard(ctx, 'winners');
        break;
      case 'leaderboard_bettors':
        await displayLeaderboard(ctx, 'bettors');
        break;
      case 'leaderboard_winrates':
        await displayLeaderboard(ctx, 'winrates');
        break;
      case 'main_menu':
        await ctx.scene.leave();
        await sendMainMenu(ctx);
        break;
      default:
        await ctx.reply('⚠️ *Unknown action in Leaderboard.* Please try again.', {
          parse_mode: 'Markdown',
        });
    }
  })
);

/**
 * Displays the leaderboard based on the selected criteria.
 * @param {Telegraf.Context} ctx - The Telegram context.
 * @param {string} criteria - The leaderboard criteria.
 */
const displayLeaderboard = async (ctx, criteria) => {
  const telegramId = ctx.from.id;
  try {
    const topUsers = await sqliteDB.getTopUsers(criteria, 10);
    let leaderboardMessage = '';

    switch (criteria) {
      case 'balances':
        leaderboardMessage = '🔝 *Top Balances*\n\n';
        if (topUsers.length === 0) {
          leaderboardMessage += 'No users found.';
        } else {
          topUsers.forEach((user, index) => {
            leaderboardMessage += `${index + 1}. ${user.username || 'Anonymous'} - ${user.usdc_balance.toFixed(
              2
            )} USDC | ${user.eth_balance.toFixed(2)} ETH | *Level ${user.level}* ${getBadge(
              user.level
            )}\n`;
          });
        }
        break;
      case 'winners':
        leaderboardMessage = '🥇 *Top Winners*\n\n';
        if (topUsers.length === 0) {
          leaderboardMessage += 'No winners yet.';
        } else {
          topUsers.forEach((user, index) => {
            leaderboardMessage += `${index + 1}. ${user.username || 'Anonymous'} - ${user.total_usdc_won.toFixed(
              2
            )} USDC won | *Level ${user.level}* ${getBadge(user.level)}\n`;
          });
        }
        break;
      case 'bettors':
        leaderboardMessage = '💰 *Top Bettors*\n\n';
        if (topUsers.length === 0) {
          leaderboardMessage += 'No bets placed yet.';
        } else {
          topUsers.forEach((user, index) => {
            leaderboardMessage += `${index + 1}. ${user.username || 'Anonymous'} - ${user.total_bets} bets placed | *Level ${user.level}* ${getBadge(
              user.level
            )}\n`;
          });
        }
        break;
      case 'winrates':
        leaderboardMessage = '📈 *Best Win Rates* (Min 10 Bets)\n\n';
        if (topUsers.length === 0) {
          leaderboardMessage += 'No users meet the criteria.';
        } else {
          topUsers.forEach((user, index) => {
            leaderboardMessage += `${index + 1}. ${user.username || 'Anonymous'} - ${user.win_rate.toFixed(
              2
            )}% | *Level ${user.level}* ${getBadge(user.level)}\n`;
          });
        }
        break;
      default:
        leaderboardMessage = '⚠️ *Invalid leaderboard criteria.*';
    }

    // Fetch the user's rank in this category
    const userRank = await sqliteDB.getUserRank(criteria, telegramId);
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    if (user && userRank) {
      leaderboardMessage += `\n🔍 *Your Rank:* ${userRank}`;
    } else if (criteria === 'winrates' && user && user.total_bets < 10) {
      leaderboardMessage += `\n🔍 *Your Rank:* Not eligible for win rate leaderboard (minimum 10 bets).`;
    } else if (user) {
      leaderboardMessage += `\n🔍 *Your Rank:* Not ranked in this category.`;
    }

    await ctx.reply(leaderboardMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Leaderboard', `leaderboard_${criteria}`)],
        [Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu')],
      ]),
    });
    logger.info(`Displayed '${criteria}' leaderboard to Telegram ID ${telegramId}`);
  } catch (error) {
    await ctx.reply('❌ Failed to fetch the leaderboard. Please try again later.');
    logger.error(`Error displaying '${criteria}' leaderboard for Telegram ID ${telegramId}:`, error.message);
  }
};

// Balance Scene
const balanceScene = new Scenes.BaseScene('balance_scene');
balanceScene.enter(async (ctx) => {
  logger.info(`Entering balance_scene for Telegram ID ${ctx.from.id}`);
  const telegramId = ctx.from.id;
  try {
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(
        '❌ You are not registered. Please use /start to register your wallet address.'
      );
      return;
    }
    const usdcBalance = user.usdc_balance
      ? user.usdc_balance.toFixed(6)
      : '0.000000';
    const ethBalance = user.eth_balance
      ? user.eth_balance.toFixed(6)
      : '0.000000';
    const balanceMessage = `📊 *Your Balances:*\n\n- *ETH:* ${ethBalance} ETH\n- *USDC:* ${usdcBalance} USDC`;

    await ctx.reply(balanceMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('🔄 Refresh Balance', 'balance'),
          Markup.button.callback('🎰 Play Degen Madhouse', 'play'),
        ],
        [
          Markup.button.callback('💵 Deposit Funds', 'deposit'),
          Markup.button.callback('💰 Withdraw Funds', 'withdraw'),
        ],
        [
          Markup.button.callback('🏆 Leaderboard', 'leaderboard'),
          Markup.button.callback('❓ Help', 'help'),
        ],
        [
          Markup.button.callback('📈 Check Level', 'level'),
          Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu'),
        ],
      ]),
    });
  } catch (error) {
    await ctx.reply('❌ Error fetching your balances. Please try again later.');
    logger.error(`Error fetching balances for Telegram ID ${telegramId}:`, error.message);
  }
});

// Refactored Callback Query Handler for Balance Scene using Helper Function
balanceScene.on(
  'callback_query',
  handleCallbackQuery(async (ctx, data) => {
    switch (data) {
      case 'balance': {
        try {
          const telegramId = ctx.from.id;
          const user = await sqliteDB.getUserByTelegramId(telegramId);
          if (!user) {
            await ctx.reply(
              '❌ You are not registered. Please use /start to register your wallet address.'
            );
            return;
          }
          const usdcBalance = user.usdc_balance
            ? user.usdc_balance.toFixed(6)
            : '0.000000';
          const ethBalance = user.eth_balance
            ? user.eth_balance.toFixed(6)
            : '0.000000';
          const balanceMessage = `📊 *Your Balances:*\n\n- *ETH:* ${ethBalance} ETH\n- *USDC:* ${usdcBalance} USDC`;

          await ctx.reply(balanceMessage, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback('🔄 Refresh Balance', 'balance'),
                Markup.button.callback('🎰 Play Degen Madhouse', 'play'),
              ],
              [
                Markup.button.callback('💵 Deposit Funds', 'deposit'),
                Markup.button.callback('💰 Withdraw Funds', 'withdraw'),
              ],
              [
                Markup.button.callback('🏆 Leaderboard', 'leaderboard'),
                Markup.button.callback('❓ Help', 'help'),
              ],
              [
                Markup.button.callback('📈 Check Level', 'level'),
                Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu'),
              ],
            ]),
          });
        } catch (error) {
          await ctx.reply(
            '❌ Error fetching your balances. Please try again later.'
          );
          logger.error(`Error fetching balances:`, error.message);
        }
        break;
      }
      case 'play':
        await ctx.scene.enter('play_scene');
        break;
      case 'deposit':
        await ctx.scene.enter('deposit_scene');
        break;
      case 'withdraw':
        await ctx.scene.enter('withdraw_scene');
        break;
      case 'leaderboard':
        await ctx.scene.enter('leaderboard_scene');
        break;
      case 'help':
        await ctx.scene.enter('help_scene');
        break;
      case 'level':
        await ctx.scene.enter('level_scene');
        break;
      case 'main_menu':
        await ctx.scene.leave();
        await sendMainMenu(ctx);
        break;
      default:
        await ctx.reply('⚠️ *Unknown action in Balance.* Please try again.', {
          parse_mode: 'Markdown',
        });
    }
  })
);

// Help Scene
const helpScene = new Scenes.BaseScene('help_scene');
helpScene.enter(async (ctx) => {
  logger.info(`Entering help_scene for Telegram ID ${ctx.from.id}`);
  const helpMessage = `
📖 *FU MONEY DEGEN MADHOUSE HELP:*

- /start: Register your Ethereum wallet address on Base Mainnet.

*Don't have any FU MONEY? Buy on Base: app.uniswap.org/swap?outputCurrency=0x8f4E4221ba88D4E9Bb76ECFB91d7C5ce08D7d5b9&chain=base*

Feel free to reach out if you have any questions or need assistance!

Telegram: [t.me/FU_Studios](https://t.me/FU_Studios)
Twitter: [x.com/fu_studios](https://x.com/fu_studios)

Open Source Project by FU STUDIOS: [github.com/sp0oby/FU-MONEY-DEGEN-MADHOUSE](https://github.com/sp0oby/FU-MONEY-DEGEN-MADHOUSE)
  `;

  await ctx.reply(helpMessage, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📈 View Leaderboard', 'leaderboard')],
      [Markup.button.callback('💰 Withdraw Funds', 'withdraw')],
      [Markup.button.callback('🎰 Play Degen Madhouse', 'play')],
      [Markup.button.callback('🔍 Check Balance', 'balance')],
      [Markup.button.callback('📈 Check Level', 'level')],
      [Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu')],
    ]),
  });
});

// Refactored Callback Query Handler for Help Scene using Helper Function
helpScene.on(
  'callback_query',
  handleCallbackQuery(async (ctx, data) => {
    switch (data) {
      case 'leaderboard':
        await ctx.scene.enter('leaderboard_scene');
        break;
      case 'withdraw':
        await ctx.scene.enter('withdraw_scene');
        break;
      case 'play':
        await ctx.scene.enter('play_scene');
        break;
      case 'balance':
        await ctx.scene.enter('balance_scene');
        break;
      case 'level':
        await ctx.scene.enter('level_scene');
        break;
      case 'main_menu':
        await ctx.scene.leave();
        await sendMainMenu(ctx);
        break;
      default:
        await ctx.reply('⚠️ *Unknown action in Help.* Please try again.', {
          parse_mode: 'Markdown',
        });
    }
  })
);

// Withdraw Scene
const withdrawScene = new Scenes.BaseScene('withdraw_scene');
withdrawScene.enter(async (ctx) => {
  logger.info(`Entering withdraw_scene for Telegram ID ${ctx.from.id}`);
  await ctx.reply(
    '💰 *Withdraw Funds*\n\nPlease choose the currency you wish to withdraw. Note that a *1% fee* will be deducted from your USDC withdrawal:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback('⚡ ETH', 'withdraw_eth'),
          Markup.button.callback('💵 USDC', 'withdraw_usdc'),
        ],
        [Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu')],
      ]),
    }
  );
});

// Refactored Callback Query Handler for Withdraw Scene using Helper Function
withdrawScene.on(
  'callback_query',
  handleCallbackQuery(async (ctx, data) => {
    switch (data) {
      case 'withdraw_eth':
        await ctx.reply(
          '💰 *ETH Withdrawal*\n\nPlease enter the amount of ETH you wish to withdraw (Ex: 0.1):',
          { parse_mode: 'Markdown' }
        );
        ctx.session.state = 'awaiting_eth_withdrawal';
        break;
      case 'withdraw_usdc':
        await ctx.reply(
          '💰 *USDC Withdrawal*\n\nPlease enter the amount of USDC you wish to withdraw. A *1% fee* will be deducted...',
          { parse_mode: 'Markdown' }
        );
        ctx.session.state = 'awaiting_usdc_withdrawal';
        break;
      case 'main_menu':
        await ctx.scene.leave();
        await sendMainMenu(ctx);
        break;
      default:
        await ctx.reply('⚠️ *Unknown action in Withdraw Funds.* Please try again.', {
          parse_mode: 'Markdown',
        });
    }
  })
);

// --------------------- NEW: Jackpot Scene ---------------------
const jackpotScene = new Scenes.BaseScene('jackpot_scene');
jackpotScene.enter(async (ctx) => {
  logger.info(`Entering jackpot_scene for Telegram ID ${ctx.from.id}`);
  await ctx.reply(
    '🔥 *Jackpot Bet*\n\nBet *100 USDC* for a *chance* to win *the entire jackpot pool*. Proceed?',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('YES - Bet 100 USDC', 'jackpot_yes')],
        [Markup.button.callback('NO - Back to Main Menu', 'jackpot_no')],
      ]),
    }
  );
});

// Refactored Callback Query Handler for Jackpot Scene using Helper Function
jackpotScene.on(
  'callback_query',
  handleCallbackQuery(async (ctx, data) => {
    const telegramId = ctx.from.id;

    switch (data) {
      case 'jackpot_yes': {
        try {
          const user = await sqliteDB.getUserByTelegramId(telegramId);
          if (!user) {
            await ctx.reply('❌ You are not registered. Please /start first.');
            await ctx.scene.leave();
            return;
          }
          // Check 100 USDC
          if (user.usdc_balance < 100) {
            await ctx.reply('❌ You no longer have 100 USDC. Bet canceled.');
            await ctx.scene.leave();
            return;
          }

          // Deduct 100 from user's USDC balance
          const newUsdcBalance = parseFloat(
            (user.usdc_balance - 100).toFixed(6)
          );
          await sqliteDB.updateUserUsdcBalance(telegramId, newUsdcBalance);
          logger.info(
            `User ${telegramId} placed a Jackpot Bet of 100 USDC. New USDC balance: ${newUsdcBalance} USDC`
          );

          // Add 100 USDC to the jackpot pool
          const currentJackpot = await sqliteDB.getJackpot();
          const newJackpot = parseFloat((currentJackpot + 100).toFixed(6));
          await sqliteDB.updateJackpot(newJackpot);
          logger.info(`Updated jackpot pool: ${newJackpot} USDC`);

          // Generate secure random number using user's wallet address as entropy
          const rng = generateSecureRandom(user.wallet_address);
          logger.info(`Generated RNG for Jackpot Bet user ${telegramId}: ${rng}`);

          // Determine result based on RNG
          const result = rng < 0.03 ? 'win' : 'lose'; // 3% chance to win

          // **Log RNG and Result for Debugging**
          logger.info(`User ${telegramId} Jackpot RNG: ${rng}, Result: ${result}`);

          // Log the seed (for verifiability purposes)
          const seed = crypto
            .createHash('sha256')
            .update(user.wallet_address + Date.now().toString() + crypto.randomBytes(16))
            .digest('hex');
          logger.info(`Seed for Jackpot Bet user ${telegramId}: ${seed}`);

          if (result === 'win') {
            // JACKPOT WIN: transfer the entire jackpot to the user
            const jackpotAmount = currentJackpot; // The entire pool before adding the bet
            if (jackpotAmount <= 0) {
              await ctx.reply(
                '⚠️ *The jackpot pool is currently empty.* Please try again later.'
              );
              await ctx.scene.leave();
              await sendMainMenu(ctx);
              return;
            }

            // Transfer jackpot from pool wallet to user (Commented out for testing)
            // const usdcAmount = ethers.utils.parseUnits(jackpotAmount.toString(), 6);
            // const txPayout = await usdcContract.transfer(user.wallet_address, usdcAmount);
            // logger.info(`Transferred ${jackpotAmount} USDC to user ${telegramId}. TX Hash: ${txPayout.hash}`);
            // await txPayout.wait();

            // Reset jackpot pool
            await sqliteDB.updateJackpot(0);
            logger.info(`Jackpot pool reset to 0 USDC after payout.`);

            // Update user's USDC balance
            const updatedUsdcBalance = parseFloat(
              (newUsdcBalance + jackpotAmount).toFixed(6)
            );
            await sqliteDB.updateUserUsdcBalance(telegramId, updatedUsdcBalance);

            // Dancing GIF
            const dancingGifs = [
              'https://media0.giphy.com/media/v1.Y2lkPTc5MGI3NjExbnhkbGNleDZtcmF6bHRuZTA3OXl2MmR1MXlrbDk2NzcxMGFlbmQwMCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/26wAd6uzCRP5VwLW8/giphy.gif',
            ];
            const randomGif =
              dancingGifs[Math.floor(Math.random() * dancingGifs.length)];

            await ctx.reply(
              `🎉 *JACKPOT WIN!*\n\nYou won the *entire jackpot pool* of ${jackpotAmount.toFixed(
                2
              )} USDC! It has been added to your in-game balance.\n\n*RNG Seed:* \`${seed}\`\n*RNG Value:* \`${rng}\`\n\nFeel free to withdraw your earnings or keep playing!`,
              { parse_mode: 'Markdown' }
            );
            await ctx.replyWithAnimation(randomGif);

            logger.info(
              `User ${telegramId} WON JACKPOT => payout ${jackpotAmount} USDC, new local balance = ${updatedUsdcBalance} USDC`
            );

            // Award XP for winning the jackpot
            await sqliteDB
              .addUserXP(telegramId, 50)
              .then(async ({ newXP, newLevel, levelUp }) => {
                if (levelUp) {
                  await ctx.replyWithMarkdown(
                    `🎉 *Level Up!* You've reached *Level ${newLevel}*. ${
                      levels[newLevel]?.reward || 'Congratulations!'
                    }`
                  );
                  await applyLevelRewards(ctx.telegram, telegramId, newLevel);
                } else {
                  await ctx.replyWithMarkdown(
                    `📈 *XP Earned:* 50 XP\n*Total XP:* ${newXP} XP`
                  );
                }
              });
          } else {
            await ctx.reply(
              '😞 You lost the Jackpot Bet of 100 USDC. Better luck next time!',
              { parse_mode: 'Markdown' }
            );
            logger.info(
              `User ${telegramId} lost JACKPOT bet => new USDC balance = ${newUsdcBalance}`
            );
            // Provide RNG seed and value for transparency
            await ctx.reply(
              `*RNG Seed:* \`${seed}\`\n*RNG Value:* \`${rng}\``,
              { parse_mode: 'Markdown' }
            );

            // Award XP for placing a jackpot bet
            await sqliteDB
              .addUserXP(telegramId, 10)
              .then(async ({ newXP, newLevel, levelUp }) => {
                if (levelUp) {
                  await ctx.replyWithMarkdown(
                    `🎉 *Level Up!* You've reached *Level ${newLevel}*. ${
                      levels[newLevel]?.reward || 'Congratulations!'
                    }`
                  );
                  await applyLevelRewards(ctx.telegram, telegramId, newLevel);
                } else {
                  await ctx.replyWithMarkdown(
                    `📈 *XP Earned:* 10 XP\n*Total XP:* ${newXP} XP`
                  );
                }
              });
          }

          await ctx.scene.leave();
          await sendMainMenu(ctx);
        } catch (err) {
          logger.error('Error processing jackpot bet:', err.message);
          await ctx.reply(
            '❌ An error occurred with your jackpot bet. Please try again later.'
          );
          await ctx.scene.leave();
        }
        break;
      }
      case 'jackpot_no':
        // User declines the Jackpot Bet, return to main menu
        await ctx.scene.leave();
        await sendMainMenu(ctx);
        break;
      default:
        await ctx.reply('⚠️ *Unknown action in Jackpot.* Please try again.', {
          parse_mode: 'Markdown',
        });
    }
  })
);

// Level Scene
const levelScene = new Scenes.BaseScene('level_scene');
levelScene.enter(async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(
        '❌ You are not registered. Please use /start to register your wallet address.'
      );
      return;
    }

    const currentLevel = user.level;
    const currentXP = user.xp;
    const nextLevelXP = sqliteDB.getXPForNextLevel(currentLevel);
    const progressPercentage = ((currentXP / nextLevelXP) * 100).toFixed(2);
    const progressBar = createProgressBar(currentXP, nextLevelXP);
    const badge = getBadge(currentLevel);

    const levelMessage = `
🎮 *Your Level: ${currentLevel}* ${badge}
📈 *XP: ${currentXP} / ${nextLevelXP}* (${progressPercentage}% towards next level)

${progressBar}
    `;

    await ctx.reply(levelMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Level', 'refresh_level')],
        [Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu')],
      ]),
    });
  } catch (error) {
    await ctx.reply(
      '❌ An error occurred while fetching your level. Please try again later.'
    );
    logger.error(`Error fetching level for Telegram ID ${telegramId}:`, error.message);
  }
});

// Handle level scene callback queries
levelScene.on(
  'callback_query',
  handleCallbackQuery(async (ctx, data) => {
    const telegramId = ctx.from.id;

    switch (data) {
      case 'refresh_level': {
        const user = await sqliteDB.getUserByTelegramId(telegramId);
        if (!user) {
          await ctx.reply(
            '❌ You are not registered. Please use /start to register your wallet address.'
          );
          return;
        }

        const currentLevel = user.level;
        const currentXP = user.xp;
        const nextLevelXP = sqliteDB.getXPForNextLevel(currentLevel);
        const progressPercentage = ((currentXP / nextLevelXP) * 100).toFixed(2);
        const progressBar = createProgressBar(currentXP, nextLevelXP);
        const badge = getBadge(currentLevel);

        const levelMessage = `
🎮 *Your Level: ${currentLevel}* ${badge}
📈 *XP: ${currentXP} / ${nextLevelXP}* (${progressPercentage}% towards next level)

${progressBar}
          `;

        await ctx.reply(levelMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh Level', 'refresh_level')],
            [Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu')],
          ]),
        });
        break;
      }
      case 'main_menu':
        await ctx.scene.leave();
        await sendMainMenu(ctx);
        break;
      default:
        await ctx.reply('⚠️ *Unknown action in Level Scene.* Please try again.', {
          parse_mode: 'Markdown',
        });
    }
  })
);

// --------------------- /level Command ---------------------
bot.command('level', async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply(
        '❌ You are not registered. Please use /start to register your wallet address.'
      );
      return;
    }

    const currentLevel = user.level;
    const currentXP = user.xp;
    const nextLevelXP = sqliteDB.getXPForNextLevel(currentLevel);
    const progressPercentage = ((currentXP / nextLevelXP) * 100).toFixed(2);
    const progressBar = createProgressBar(currentXP, nextLevelXP);
    const badge = getBadge(currentLevel);

    const levelMessage = `
🎮 *Your Level: ${currentLevel}* ${badge}
📈 *XP: ${currentXP} / ${nextLevelXP}* (${progressPercentage}% towards next level)

${progressBar}
    `;

    await ctx.reply(levelMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Level', 'refresh_level')],
        [Markup.button.callback('🏠 Go Back to Main Menu', 'main_menu')],
      ]),
    });
  } catch (error) {
    await ctx.reply(
      '❌ An error occurred while fetching your level. Please try again later.'
    );
    logger.error(`Error fetching level for Telegram ID ${telegramId}:`, error.message);
  }
});

// --------------------- Level-Up Rewards ---------------------
// (Already defined above as 'levels' and 'applyLevelRewards')

// --------------------- Scene Registration ---------------------
const stage = new Scenes.Stage([
  registrationScene,
  playScene,
  depositScene,
  leaderboardScene,
  balanceScene,
  helpScene,
  withdrawScene,
  jackpotScene, // Added Jackpot Scene
  levelScene,
]);
bot.use(stage.middleware());

// --------------------- /start Command ---------------------
bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    if (user) {
      await ctx.reply(
        '✅ You are already registered. Use /help to see available commands.'
      );
      await sendMainMenu(ctx);
    } else {
      ctx.scene.enter('registration');
    }
  } catch (error) {
    await ctx.reply('❌ An error occurred. Please try again later.');
    logger.error(`Error checking registration for Telegram ID ${telegramId}:`, error.message);
  }
});

// --------------------- Global Callback Query Handler ---------------------
bot.on('callback_query', async (ctx, next) => {
  // Check if the user is in a scene
  if (ctx.scene.current) {
    // User is in a scene; let the scene handle the callback query
    return;
  }

  const data = ctx.callbackQuery.data;
  const telegramId = ctx.from.id;

  logger.info(`Global Callback Query Received: ${data} from Telegram ID ${telegramId}`);

  try {
    // Answer the callback query immediately to prevent timeout
    await ctx.answerCbQuery();

    switch (data) {
      case 'play':
        logger.info(`Entering play_scene for Telegram ID ${telegramId}`);
        await ctx.scene.enter('play_scene');
        break;
      case 'deposit':
        logger.info(`Entering deposit_scene for Telegram ID ${telegramId}`);
        await ctx.scene.enter('deposit_scene');
        break;
      case 'balance':
        logger.info(`Entering balance_scene for Telegram ID ${telegramId}`);
        await ctx.scene.enter('balance_scene');
        break;
      case 'leaderboard':
        logger.info(`Entering leaderboard_scene for Telegram ID ${telegramId}`);
        await ctx.scene.enter('leaderboard_scene');
        break;
      case 'help':
        logger.info(`Entering help_scene for Telegram ID ${telegramId}`);
        await ctx.scene.enter('help_scene');
        break;
      case 'withdraw':
        logger.info(`Entering withdraw_scene for Telegram ID ${telegramId}`);
        await ctx.scene.enter('withdraw_scene');
        break;
      case 'view_pool': {
        try {
          const jackpot = await sqliteDB.getJackpot();
          await ctx.reply(
            `🏆 *Current Jackpot Pool:* ${jackpot.toFixed(2)} USDC`,
            { parse_mode: 'Markdown' }
          );
          logger.info(`User ${telegramId} viewed the jackpot pool: ${jackpot} USDC`);
        } catch (err) {
          logger.error('Error fetching jackpot pool:', err.message);
          await ctx.reply(
            '❌ Failed to fetch the jackpot pool. Please try again later.'
          );
        }
        break;
      }
      case 'level':
        await ctx.scene.enter('level_scene');
        break;
      default:
        logger.warn(`Unknown action received: ${data} from Telegram ID ${telegramId}`);
        await ctx.reply('⚠️ *Unknown action.* Please try again.', { parse_mode: 'Markdown' });
    }
  } catch (error) {
    logger.error(`Error handling callback query '${data}' for Telegram ID ${telegramId}:`, error.message);
    await ctx.reply(
      '❌ An error occurred while processing your request. Please try again later.'
    );
  }
});

// --------------------- Withdrawal Input Handlers (When user types an amount) ---------------------
bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const user = await sqliteDB.getUserByTelegramId(telegramId);

  if (!user) {
    await ctx.reply(
      '❌ You are not registered. Please use /start to register your wallet address.'
    );
    return;
  }

  if (ctx.session.state === 'awaiting_eth_withdrawal') {
    const input = ctx.message.text.trim();
    const amount = Number(input);
    if (!isValidAmount(input)) {
      await ctx.reply('❌ *Invalid input.* Please enter a valid amount of ETH to withdraw.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const MAX_ETH_WITHDRAWAL = 100; // Example limit
    if (amount > MAX_ETH_WITHDRAWAL) {
      await ctx.reply(
        `⚠️ *Maximum ETH withdrawal per transaction is ${MAX_ETH_WITHDRAWAL} ETH.* Please enter a smaller amount.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (user.eth_balance < amount) {
      await ctx.reply('⚠️ *Insufficient ETH balance.* Please enter a smaller amount.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    try {
      await ctx.reply('🔄 *Processing your ETH withdrawal...*', {
        parse_mode: 'Markdown',
      });

      // Implement your withdrawETH function here
      // Example:
      const txHash = await withdrawETH(user.wallet_address, amount); // Ensure this function is defined

      const updatedEthBalance = parseFloat((user.eth_balance - amount).toFixed(6));
      await sqliteDB.updateUserEthBalance(telegramId, updatedEthBalance);

      await ctx.reply(
        `✅ You have withdrawn *${amount} ETH*.\n\n*Transaction Hash:* [${txHash}](https://sepolia.etherscan.io/tx/${txHash})\n\n*Your new ETH balance:* ${updatedEthBalance} ETH`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      logger.info(`User ${telegramId} withdrew ${amount} ETH. TX Hash: ${txHash}`);

      ctx.session.state = null;
      await ctx.scene.leave();
      await sendMainMenu(ctx);
    } catch (error) {
      await ctx.reply('❌ Failed to process your ETH withdrawal. Please try again later.');
      logger.error(`Failed ETH withdrawal for Telegram ID ${telegramId}:`, error.message);
    }
  } else if (ctx.session.state === 'awaiting_usdc_withdrawal') {
    const input = ctx.message.text.trim();
    const amount = Number(input);
    if (!isValidAmount(input)) {
      await ctx.reply('❌ *Invalid input.* Please enter a valid amount of USDC to withdraw.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    const MAX_USDC_WITHDRAWAL = 10000;
    if (amount > MAX_USDC_WITHDRAWAL) {
      await ctx.reply(
        `⚠️ *Maximum USDC withdrawal per transaction is ${MAX_USDC_WITHDRAWAL} USDC.* Please enter a smaller amount.`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (user.usdc_balance < amount) {
      await ctx.reply('⚠️ *Insufficient USDC balance.* Please enter a smaller amount.', {
        parse_mode: 'Markdown',
      });
      return;
    }

    try {
      await ctx.reply('🔄 *Processing your USDC withdrawal...*', {
        parse_mode: 'Markdown',
      });

      // Implement your withdrawUSDC function here
      // Example:
      const txHash = await withdrawUSDC(user.wallet_address, amount); // Ensure this function is defined

      const updatedUsdcBalance = parseFloat((user.usdc_balance - amount).toFixed(6));
      await sqliteDB.updateUserUsdcBalance(telegramId, updatedUsdcBalance);

      await ctx.reply(
        `✅ You have withdrawn *${amount} USDC*.\n\n*Transaction Hash:* [${txHash}](https://sepolia.etherscan.io/tx/${txHash})\n\n*Your new USDC balance:* ${updatedUsdcBalance} USDC`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      logger.info(`User ${telegramId} withdrew ${amount} USDC. TX Hash: ${txHash}`);

      ctx.session.state = null;
      await ctx.scene.leave();
      await sendMainMenu(ctx);
    } catch (error) {
      await ctx.reply('❌ Failed to process your USDC withdrawal. Please try again later.');
      logger.error(`Failed USDC withdrawal for Telegram ID ${telegramId}:`, error.message);
    }
  } else {
    // Not in a recognized input state
    await ctx.reply(
      '⚠️ *Unrecognized command or state.* Please use the main menu or /help for assistance.',
      { parse_mode: 'Markdown' }
    );
  }
});

// --------------------- Deposit Monitoring ---------------------

const usdcDepositAbi = [
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const usdcDepositContract = new ethers.Contract(
  process.env.USDC_CONTRACT_ADDRESS,
  usdcDepositAbi,
  provider
);
const poolAddressLower = process.env.POOL_ADDRESS.toLowerCase();

usdcDepositContract.on('Transfer', async (from, to, value, event) => {
  try {
    if (to.toLowerCase() === poolAddressLower) {
      const usdcAmount = parseFloat(ethers.utils.formatUnits(value, 6));
      logger.info(`📥 USDC Deposit Received: ${usdcAmount} USDC from ${from}`);

      const query = `SELECT telegram_id FROM users WHERE wallet_address = ?`;
      sqliteDB.db.get(query, [from], async (err, row) => {
        if (err) {
          logger.error(`Error fetching user for USDC deposit from ${from}:`, err.message);
        } else if (!row) {
          logger.warn(`No user found with wallet address ${from} for USDC deposit.`);
        } else {
          const telegramId = row.telegram_id;
          const user = await sqliteDB.getUserByTelegramId(telegramId);
          if (!user) {
            logger.warn(`User with Telegram ID ${telegramId} not found.`);
            return;
          }
          const updatedUsdcBalance = parseFloat(
            (user.usdc_balance + usdcAmount).toFixed(6)
          );
          await sqliteDB.updateUserUsdcBalance(telegramId, updatedUsdcBalance);

          await bot.telegram.sendMessage(
            telegramId,
            `📥 *Deposit Received!*\n\nYou have received *${usdcAmount} USDC*.\n\n*Updated Balances:*\n- ETH: ${user.eth_balance.toFixed(
              6
            )} ETH\n- USDC: ${updatedUsdcBalance.toFixed(6)} USDC`,
            { parse_mode: 'Markdown' }
          );
          logger.info(
            `Updated USDC balance for Telegram ID ${telegramId}: ${updatedUsdcBalance} USDC`
          );

          // Award XP for depositing
          await sqliteDB
            .addUserXP(telegramId, 15)
            .then(async ({ newXP, newLevel, levelUp }) => {
              if (levelUp) {
                await bot.telegram.sendMessage(
                  telegramId,
                  `🎉 *Level Up!* You've reached *Level ${newLevel}*. ${
                    levels[newLevel]?.reward || 'Congratulations!'
                  }`,
                  { parse_mode: 'Markdown' }
                );
                await applyLevelRewards(bot.telegram, telegramId, newLevel);
              } else {
                await bot.telegram.sendMessage(
                  telegramId,
                  `📈 *XP Earned:* 15 XP\n*Total XP:* ${newXP} XP`,
                  { parse_mode: 'Markdown' }
                );
              }
            });
        }
      });
    }
  } catch (error) {
    logger.error('Error processing USDC deposit:', error.message);
  }
});

provider.on('block', async (blockNumber) => {
  try {
    const confirmations = 6;
    const confirmedBlockNumber = blockNumber - confirmations;
    if (confirmedBlockNumber < 0) return;

    const block = await provider.getBlockWithTransactions(confirmedBlockNumber);
    logger.info(`Processing block ${confirmedBlockNumber} for ETH deposits.`);

    for (const tx of block.transactions) {
      if (tx.to && tx.to.toLowerCase() === poolAddressLower) {
        const ethAmount = parseFloat(ethers.utils.formatEther(tx.value));
        if (ethAmount > 0) {
          logger.info(`📥 ETH Deposit Received: ${ethAmount} ETH from ${tx.from}`);

          const query = `SELECT telegram_id FROM users WHERE wallet_address = ?`;
          sqliteDB.db.get(query, [tx.from], async (err, row) => {
            if (err) {
              logger.error(`Error fetching user for ETH deposit from ${tx.from}:`, err.message);
            } else if (!row) {
              logger.warn(`No user found with wallet address ${tx.from} for ETH deposit.`);
            } else {
              const telegramId = row.telegram_id;
              const user = await sqliteDB.getUserByTelegramId(telegramId);
              if (!user) {
                logger.warn(`User with Telegram ID ${telegramId} not found.`);
                return;
              }
              const updatedEthBalance = parseFloat(
                (user.eth_balance + ethAmount).toFixed(6)
              );
              await sqliteDB.updateUserEthBalance(telegramId, updatedEthBalance);

              await bot.telegram.sendMessage(
                telegramId,
                `📥 *Deposit Received!*\n\nYou have received *${ethAmount} ETH*.\n\n*Updated Balances:*\n- ETH: ${updatedEthBalance.toFixed(
                  6
                )} ETH\n- USDC: ${user.usdc_balance.toFixed(6)} USDC`,
                { parse_mode: 'Markdown' }
              );
              logger.info(
                `Updated ETH balance for Telegram ID ${telegramId}: ${updatedEthBalance} ETH`
              );

              // Award XP for depositing
              await sqliteDB
                .addUserXP(telegramId, 15)
                .then(async ({ newXP, newLevel, levelUp }) => {
                  if (levelUp) {
                    await bot.telegram.sendMessage(
                      telegramId,
                      `🎉 *Level Up!* You've reached *Level ${newLevel}*. ${
                        levels[newLevel]?.reward || 'Congratulations!'
                      }`,
                      { parse_mode: 'Markdown' }
                    );
                    await applyLevelRewards(bot.telegram, telegramId, newLevel);
                  } else {
                    await bot.telegram.sendMessage(
                      telegramId,
                      `📈 *XP Earned:* 15 XP\n*Total XP:* ${newXP} XP`,
                      { parse_mode: 'Markdown' }
                    );
                  }
                });
            }
          });
        }
      }
    }
  } catch (error) {
    logger.error('Error processing ETH deposits:', error.message);
  }
});

// --------------------- Dual-Mode Webhook or Polling ---------------------

const MODE = process.env.MODE || 'polling'; // 'webhook' for hosting, 'polling' for local
if (MODE === 'webhook') {
  const app = express();
  app.use(express.json());

  const pathWebhook = `/webhook/${bot.token}`;
  app.use(pathWebhook, (req, res) => {
    bot.handleUpdate(req.body, res);
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 Bot is running in webhook mode on port ${PORT}`);
  });

  bot.telegram
    .setWebhook(`${process.env.WEBHOOK_URL}${pathWebhook}`)
    .then(() => {
      logger.info(`✅ Webhook set: ${process.env.WEBHOOK_URL}${pathWebhook}`);
    })
    .catch((err) => {
      logger.error('❌ Error setting webhook:', err.message);
    });
} else {
  // Polling mode
  bot
    .launch()
    .then(() => {
      logger.info('✅ Bot is running in polling mode...');
      logger.info('✅ Deposit monitoring is active.');
    })
    .catch((error) => {
      logger.error('❌ Error launching the bot in polling mode:', error.message);
    });
}

// --------------------- Graceful Shutdown ---------------------
process.once('SIGINT', () => {
  bot.stop('SIGINT');
  logger.info('🛑 Bot stopped gracefully (SIGINT).');
});
process.once('SIGTERM', () => {
  bot.stop('SIGTERM');
  logger.info('🛑 Bot stopped gracefully (SIGTERM).');
});

// --------------------- Important: Define withdrawETH and withdrawUSDC Functions ---------------------

/**
 * Handles ETH withdrawal by sending ETH to the user's wallet address.
 * @param {string} walletAddress - The user's Ethereum wallet address.
 * @param {number} amount - The amount of ETH to withdraw.
 * @returns {Promise<string>} - The transaction hash of the withdrawal.
 */
const withdrawETH = async (walletAddress, amount) => {
  // Implement the withdrawal logic using ethers.js
  try {
    const tx = await poolWallet.sendTransaction({
      to: walletAddress,
      value: ethers.utils.parseEther(amount.toString()),
    });
    logger.info(`ETH Withdrawal Transaction Hash: ${tx.hash}`);
    await tx.wait();
    return tx.hash;
  } catch (error) {
    logger.error(`Error withdrawing ETH to ${walletAddress}:`, error.message);
    throw error;
  }
};

/**
 * Handles USDC withdrawal by sending USDC to the user's wallet address.
 * @param {string} walletAddress - The user's Ethereum wallet address.
 * @param {number} amount - The amount of USDC to withdraw.
 * @returns {Promise<string>} - The transaction hash of the withdrawal.
 */
const withdrawUSDC = async (walletAddress, amount) => {
  // Implement the withdrawal logic using ethers.js
  try {
    const usdcAmount = ethers.utils.parseUnits(amount.toString(), 6);
    const tx = await usdcContract.transfer(walletAddress, usdcAmount);
    logger.info(`USDC Withdrawal Transaction Hash: ${tx.hash}`);
    await tx.wait();
    return tx.hash;
  } catch (error) {
    logger.error(`Error withdrawing USDC to ${walletAddress}:`, error.message);
    throw error;
  }
};
