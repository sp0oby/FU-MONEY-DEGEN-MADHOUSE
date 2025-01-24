// index.js

require('dotenv').config();
const express = require('express');
const { Telegraf, session, Scenes, Markup } = require('telegraf');
const logger = require('./services/logger'); // Ensure this path is correct
const sqliteDB = require('./utils/sqliteDB'); // Ensure this path is correct
const { ethers } = require('ethers');

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

// --------------------- Helper Function for Input Validation ---------------------

/**
 * Validates if the input string is a valid positive number.
 * @param {string} input - The input string to validate.
 * @returns {boolean} - Returns true if valid, else false.
 */
const isValidAmount = (input) => {
  const amount = Number(input);
  return !isNaN(amount) && amount > 0 && input === amount.toString();
};

// --------------------- Function Definitions ---------------------

/**
 * Initiates an ETH withdrawal to the user's wallet with a 1% fee.
 * @param {string} toAddress - The Ethereum address of the user.
 * @param {number} amount - The amount of ETH to withdraw.
 * @returns {Promise<string>} - Returns the transaction hash.
 */
const withdrawETH = async (toAddress, amount) => {
  try {
    // Calculate 1% fee
    const fee = parseFloat((amount * 0.01).toFixed(6));
    const amountAfterFee = parseFloat((amount - fee).toFixed(6));

    // Convert ETH amounts to Wei
    const amountInWei = ethers.utils.parseEther(amountAfterFee.toString());
    const feeInWei = ethers.utils.parseEther(fee.toString());

    // Check Pool Wallet's ETH Balance
    const poolEthBalance = await poolWallet.getBalance();
    if (poolEthBalance.lt(amountInWei.add(feeInWei))) {
      throw new Error(
        'Insufficient ETH in Pool Wallet to cover the withdrawal and fee.'
      );
    }

    // Create transaction to user
    const txUser = await poolWallet.sendTransaction({
      to: toAddress,
      value: amountInWei,
    });

    logger.info(`ETH Withdrawal Transaction Hash (User): ${txUser.hash}`);

    // Wait for the transaction to be mined
    await txUser.wait();

    // Create transaction to team wallet for fee
    const txFee = await poolWallet.sendTransaction({
      to: TEAM_WALLET_ADDRESS,
      value: feeInWei,
    });

    logger.info(`ETH Withdrawal Transaction Hash (Fee): ${txFee.hash}`);

    // Wait for the transaction to be mined
    await txFee.wait();

    return txUser.hash; // Optionally return both hashes if needed
  } catch (error) {
    logger.error(`Error withdrawing ETH to ${toAddress}:`, error);
    throw error;
  }
};

/**
 * Initiates a USDC withdrawal to the user's wallet with a 1% fee.
 * @param {string} toAddress - The Ethereum address of the user.
 * @param {number} amount - The amount of USDC to withdraw.
 * @returns {Promise<string>} - Returns the transaction hash.
 */
const withdrawUSDC = async (toAddress, amount) => {
  try {
    // USDC has 6 decimals
    const decimals = 6;

    // Calculate 1% fee
    const fee = parseFloat((amount * 0.01).toFixed(6));
    const amountAfterFee = parseFloat((amount - fee).toFixed(6));

    const amountWithDecimals = ethers.utils.parseUnits(
      amountAfterFee.toString(),
      decimals
    );
    const feeWithDecimals = ethers.utils.parseUnits(fee.toString(), decimals);

    // Check Pool Wallet's USDC Balance
    const poolUsdcBalance = await usdcContract.balanceOf(poolWallet.address);
    if (poolUsdcBalance.lt(amountWithDecimals.add(feeWithDecimals))) {
      throw new Error(
        'Insufficient USDC in Pool Wallet to cover the withdrawal and fee.'
      );
    }

    // Create transaction to user
    const txUser = await usdcContract.transfer(toAddress, amountWithDecimals);
    logger.info(`USDC Withdrawal Transaction Hash (User): ${txUser.hash}`);

    // Wait for the transaction to be mined
    await txUser.wait();

    // Create transaction to team wallet for fee
    const txFee = await usdcContract.transfer(
      TEAM_WALLET_ADDRESS,
      feeWithDecimals
    );
    logger.info(`USDC Withdrawal Transaction Hash (Fee): ${txFee.hash}`);

    // Wait for the transaction to be mined
    await txFee.wait();

    return txUser.hash; // Optionally return both hashes if needed
  } catch (error) {
    logger.error(`Error withdrawing USDC to ${toAddress}:`, error);
    throw error;
  }
};

/**
 * Handles the betting logic for the Play Slots feature.
 * @param {Telegraf.Context} ctx - The Telegraf context.
 * @param {number} betAmount - The amount of USDC the user wants to bet.
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

    // Define maximum withdrawal limits (optional)
    const MAX_ETH_WITHDRAWAL = 100; // Example limit
    const MAX_USDC_WITHDRAWAL = 10000; // Example limit

    // Deduct bet amount from user's USDC balance
    const newUsdcBalance = parseFloat((user.usdc_balance - betAmount).toFixed(6));
    await sqliteDB.updateUserUsdcBalance(telegramId, newUsdcBalance);
    logger.info(
      `User ${telegramId} placed a bet of ${betAmount} USDC. New USDC balance: ${newUsdcBalance} USDC`
    );

    // Simulate slot game result
    const result = Math.random() < 0.25 ? 'win' : 'lose';
    if (result === 'win') {
      // Define payout logic, e.g., 2x bet
      const payout = betAmount * 2;
      const updatedUsdcBalance = parseFloat(
        (newUsdcBalance + payout).toFixed(6)
      );
      await sqliteDB.updateUserUsdcBalance(telegramId, updatedUsdcBalance);
      await ctx.reply(
        `🎉 *You won!*\n\nPayout: *${payout} USDC*\n\n*Your new USDC balance:* ${updatedUsdcBalance} USDC`,
        { parse_mode: 'Markdown' }
      );
      logger.info(
        `User ${telegramId} won ${payout} USDC. New USDC balance: ${updatedUsdcBalance} USDC`
      );
    } else {
      await ctx.reply(
        `😞 *You lost ${betAmount} USDC.*\n\n*Your new USDC balance:* ${newUsdcBalance} USDC`,
        { parse_mode: 'Markdown' }
      );
      logger.info(
        `User ${telegramId} lost ${betAmount} USDC. New USDC balance: ${newUsdcBalance} USDC`
      );
    }

    // Exit the scene and return to main menu
    await ctx.scene.leave();
    await sendMainMenu(ctx);
  } catch (error) {
    await ctx.reply('❌ Error processing your bet. Please try again later.');
    logger.error(`Error processing USDC bet for Telegram ID ${telegramId}:`, error);
  }
};

/**
 * Sends the main menu to the user with various options.
 * @param {Telegraf.Context} ctx - The Telegraf context.
 */
const sendMainMenu = async (ctx) => {
  const mainMenuMessage = `
🏠 *Main Menu*

Choose an option below:
    `;

  const inlineButtons = Markup.inlineKeyboard([
    [Markup.button.callback('🎰 Play Slots', 'play'), Markup.button.callback('💵 Deposit Funds', 'deposit')],
    [Markup.button.callback('💰 Withdraw Funds', 'withdraw'), Markup.button.callback('📊 View Balance', 'balance')],
    [Markup.button.callback('🏆 Leaderboard', 'leaderboard'), Markup.button.callback('❓ Help', 'help')],
  ]);

  await ctx.reply(mainMenuMessage, {
    parse_mode: 'Markdown',
    ...inlineButtons,
  });
};

// --------------------- Scene Definitions ---------------------

const registrationScene = new Scenes.BaseScene('registration');
registrationScene.enter((ctx) => {
  logger.info(`Entering registration scene for Telegram ID ${ctx.from.id}`);
  ctx.reply(
    '👋 *Welcome to the Slots Bot!*\n\nPlease send your Ethereum wallet address to register.',
    { parse_mode: 'Markdown' }
  );
});

registrationScene.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const walletAddress = ctx.message.text.trim();

  // Validate Ethereum address
  if (!ethers.utils.isAddress(walletAddress)) {
    await ctx.reply('❌ *Invalid Ethereum address.* Please send a valid address.', {
      parse_mode: 'Markdown',
    });
    return;
  }

  try {
    await sqliteDB.addOrUpdateUser(telegramId, walletAddress);
    await ctx.reply(
      '✅ *Registration successful!*\n\nYou can now use the bot commands. Use /help to see available commands.',
      { parse_mode: 'Markdown' }
    );
    logger.info(`User registered: Telegram ID ${telegramId}, Wallet Address ${walletAddress}`);
    ctx.scene.leave();
    await sendMainMenu(ctx);
  } catch (error) {
    await ctx.reply('❌ An error occurred during registration. Please try again.');
    logger.error(`Error registering user ${telegramId}:`, error);
    ctx.scene.leave();
  }
});

registrationScene.on('message', (ctx) => {
  ctx.reply('❌ Please send a valid Ethereum wallet address to register.');
});

/**
 * Play Scene
 */
const playScene = new Scenes.BaseScene('play_scene');
playScene.enter((ctx) => {
  logger.info(`Entering play_scene for Telegram ID ${ctx.from.id}`);
  ctx.reply('🎰 *Play Slots*\n\nChoose your bet amount:', {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('💵 5 USDC', 'bet_usdc_5'), Markup.button.callback('💵 10 USDC', 'bet_usdc_10')],
      [Markup.button.callback('💵 100 USDC', 'bet_usdc_100'), Markup.button.callback('💵 1,000 USDC', 'bet_usdc_1000')],
      [Markup.button.callback('💵 10,000 USDC', 'bet_usdc_10000'), Markup.button.callback('🔙 Back to Main Menu', 'main_menu')],
    ]),
  });
});

playScene.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const telegramId = ctx.from.id;

  logger.info(`Play Scene Callback Query: ${data} from Telegram ID ${telegramId}`);

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
      await ctx.reply('⚠️ *Unknown action in Play Slots.* Please try again.', { parse_mode: 'Markdown' });
  }

  await ctx.answerCbQuery();
});

/**
 * Deposit Scene
 */
const depositScene = new Scenes.BaseScene('deposit_scene');
depositScene.enter(async (ctx) => {
  logger.info(`Entering deposit_scene for Telegram ID ${ctx.from.id}`);
  const poolAddress = process.env.POOL_ADDRESS;
  const depositMessage = `📥 *Depositing Funds*\n\nPlease transfer your desired amount to the pool address below:\n\n- *USDC:* ${poolAddress}\n- *ETH:* ${poolAddress}\n\nYour balances will update automatically upon successful deposits.`;

  await ctx.reply(depositMessage, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔄 Refresh Deposit Instructions', 'deposit'), Markup.button.callback('🔙 Back to Main Menu', 'main_menu')],
    ]),
  });
});

depositScene.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  switch (data) {
    case 'deposit':
      const poolAddress = process.env.POOL_ADDRESS;
      const updatedDepositMessage = `📥 *Depositing Funds*\n\nPlease transfer your desired amount to the pool address below:\n\n- *USDC:* ${poolAddress}\n- *ETH:* ${poolAddress}\n\nYour balances will update automatically upon successful deposits.`;
      await ctx.reply(updatedDepositMessage, { parse_mode: 'Markdown' });
      break;
    case 'main_menu':
      await ctx.scene.leave();
      await sendMainMenu(ctx);
      break;
    default:
      await ctx.reply('⚠️ *Unknown action in Deposit Funds.* Please try again.', { parse_mode: 'Markdown' });
  }

  await ctx.answerCbQuery();
});

/**
 * Leaderboard Scene
 */
const leaderboardScene = new Scenes.BaseScene('leaderboard_scene');
leaderboardScene.enter(async (ctx) => {
  logger.info(`Entering leaderboard_scene for Telegram ID ${ctx.from.id}`);
  try {
    const query = `SELECT telegram_id, eth_balance, usdc_balance FROM users ORDER BY usdc_balance DESC, eth_balance DESC LIMIT 10`;
    sqliteDB.db.all(query, [], async (err, rows) => {
      if (err) {
        logger.error('Error fetching leaderboard:', err);
        await ctx.reply('❌ Error fetching leaderboard.');
        return;
      }
      if (rows.length === 0) {
        await ctx.reply('📈 *Leaderboard*\n\nNo users found.');
        return;
      }
      let leaderboard = '🏆 *Leaderboard*\n\n';
      rows.forEach((row, index) => {
        leaderboard += `${index + 1}. Telegram ID: ${row.telegram_id}\n   - ETH: ${row.eth_balance.toFixed(6)} ETH\n   - USDC: ${row.usdc_balance.toFixed(6)} USDC\n\n`;
      });

      await ctx.reply(leaderboard, {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔄 Refresh Leaderboard', 'leaderboard'), Markup.button.callback('🔙 Back to Main Menu', 'main_menu')],
        ]),
      });
    });
  } catch (error) {
    await ctx.reply('❌ Error fetching leaderboard. Please try again later.');
    logger.error('Error fetching leaderboard:', error);
  }
});

leaderboardScene.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  switch (data) {
    case 'leaderboard':
      try {
        const query = `SELECT telegram_id, eth_balance, usdc_balance FROM users ORDER BY usdc_balance DESC, eth_balance DESC LIMIT 10`;
        sqliteDB.db.all(query, [], async (err, rows) => {
          if (err) {
            logger.error('Error fetching leaderboard:', err);
            await ctx.reply('❌ Error fetching leaderboard.');
            return;
          }
          if (rows.length === 0) {
            await ctx.reply('📈 *Leaderboard*\n\nNo users found.');
            return;
          }
          let leaderboard = '🏆 *Leaderboard*\n\n';
          rows.forEach((row, index) => {
            leaderboard += `${index + 1}. Telegram ID: ${row.telegram_id}\n   - ETH: ${row.eth_balance.toFixed(6)} ETH\n   - USDC: ${row.usdc_balance.toFixed(6)} USDC\n\n`;
          });

          await ctx.reply(leaderboard, {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
              [Markup.button.callback('🔄 Refresh Leaderboard', 'leaderboard'), Markup.button.callback('🔙 Back to Main Menu', 'main_menu')],
            ]),
          });
        });
      } catch (error) {
        await ctx.reply('❌ Error fetching leaderboard. Please try again later.');
        logger.error('Error fetching leaderboard:', error);
      }
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

  await ctx.answerCbQuery();
});

/**
 * Balance Scene
 */
const balanceScene = new Scenes.BaseScene('balance_scene');
balanceScene.enter(async (ctx) => {
  logger.info(`Entering balance_scene for Telegram ID ${ctx.from.id}`);
  const telegramId = ctx.from.id;
  try {
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    if (!user) {
      await ctx.reply('❌ You are not registered. Please use /start to register your wallet address.');
      return;
    }
    const usdcBalance = user.usdc_balance.toFixed(6);
    const ethBalance = user.eth_balance.toFixed(6);
    const balanceMessage = `📊 *Your Balances:*\n\n- *ETH:* ${ethBalance} ETH\n- *USDC:* ${usdcBalance} USDC`;

    await ctx.reply(balanceMessage, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔄 Refresh Balance', 'balance'), Markup.button.callback('🎰 Play Slots', 'play')],
        [Markup.button.callback('💵 Deposit Funds', 'deposit'), Markup.button.callback('💰 Withdraw Funds', 'withdraw')],
      ]),
    });
  } catch (error) {
    await ctx.reply('❌ Error fetching your balances. Please try again later.');
    logger.error(`Error fetching balances for Telegram ID ${telegramId}:`, error);
  }
});

balanceScene.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  switch (data) {
    case 'balance':
      try {
        const telegramId = ctx.from.id;
        const user = await sqliteDB.getUserByTelegramId(telegramId);
        if (!user) {
          await ctx.reply('❌ You are not registered. Please use /start to register your wallet address.');
          return;
        }
        const usdcBalance = user.usdc_balance.toFixed(6);
        const ethBalance = user.eth_balance.toFixed(6);
        const balanceMessage = `📊 *Your Balances:*\n\n- *ETH:* ${ethBalance} ETH\n- *USDC:* ${usdcBalance} USDC`;

        await ctx.reply(balanceMessage, {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh Balance', 'balance'), Markup.button.callback('🎰 Play Slots', 'play')],
            [Markup.button.callback('💵 Deposit Funds', 'deposit'), Markup.button.callback('💰 Withdraw Funds', 'withdraw')],
          ]),
        });
      } catch (error) {
        await ctx.reply('❌ Error fetching your balances. Please try again later.');
        logger.error(`Error fetching balances:`, error);
      }
      break;
    case 'play':
      await ctx.scene.enter('play_scene');
      break;
    case 'deposit':
      await ctx.scene.enter('deposit_scene');
      break;
    case 'withdraw':
      await ctx.scene.enter('withdraw_scene');
      break;
    default:
      await ctx.reply('⚠️ *Unknown action in Balance.* Please try again.', { parse_mode: 'Markdown' });
  }

  await ctx.answerCbQuery();
});

/**
 * Help Scene
 */
const helpScene = new Scenes.BaseScene('help_scene');
helpScene.enter(async (ctx) => {
  logger.info(`Entering help_scene for Telegram ID ${ctx.from.id}`);
  const helpMessage = `
📖 *Slots Bot Commands:*

- /start: Register your Ethereum wallet address.
- /help: Show this help message.
- /balance: View your ETH and USDC balances.
- /deposit: Get instructions to deposit ETH or USDC.
- /withdraw: Withdraw ETH or USDC from your balance.
- /play: Play the slots game using your USDC balance.
- /leaderboard: View the top 10 users based on their balances.

*How to Use the Bot:*

1. *Register:* Start by sending /start and provide your Ethereum wallet address when prompted.
2. *Deposit:* Use /deposit to find out how to add ETH or USDC to your account.
3. *Play:* Engage in the slots game by sending /play and choosing your bet amount.
4. *Withdraw:* Retrieve your funds anytime using /withdraw.
5. *Check Balances:* Monitor your ETH and USDC balances with /balance.
6. *Leaderboard:* See how you rank against other users with /leaderboard.

Feel free to reach out if you have any questions or need assistance!
  `;

  await ctx.reply(helpMessage, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('📈 View Leaderboard', 'leaderboard'), Markup.button.callback('💰 Withdraw Funds', 'withdraw')],
      [Markup.button.callback('🎰 Play Slots', 'play'), Markup.button.callback('🔍 Check Balance', 'balance')],
    ]),
  });
});

helpScene.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

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
    default:
      await ctx.reply('⚠️ *Unknown action in Help.* Please try again.', { parse_mode: 'Markdown' });
  }

  await ctx.answerCbQuery();
});

/**
 * Withdraw Scene
 */
const withdrawScene = new Scenes.BaseScene('withdraw_scene');
withdrawScene.enter(async (ctx) => {
  logger.info(`Entering withdraw_scene for Telegram ID ${ctx.from.id}`);
  await ctx.reply(
    '💰 *Withdraw Funds*\n\nPlease choose the currency you wish to withdraw. Note that a *1% fee* will be deducted from your withdrawal:',
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⚡ ETH', 'withdraw_eth'), Markup.button.callback('💵 USDC', 'withdraw_usdc')],
        [Markup.button.callback('🔙 Back to Main Menu', 'main_menu')],
      ]),
    }
  );
});

withdrawScene.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  switch (data) {
    case 'withdraw_eth':
      await ctx.reply(
        '💰 *ETH Withdrawal*\n\nPlease enter the amount of ETH you wish to withdraw. A *1% fee* will be deducted from your withdrawal and added to FU MONEY liquidity.:',
        { parse_mode: 'Markdown' }
      );
      ctx.session.state = 'awaiting_eth_withdrawal';
      break;
    case 'withdraw_usdc':
      await ctx.reply(
        '💰 *USDC Withdrawal*\n\nPlease enter the amount of USDC you wish to withdraw. A *1% fee* will be deducted and BURNED from your withdrawal:',
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

  await ctx.answerCbQuery();
});

// --------------------- Scene Registration ---------------------

const stage = new Scenes.Stage([
  registrationScene,
  playScene,
  depositScene,
  leaderboardScene,
  balanceScene,
  helpScene,
  withdrawScene,
]);
bot.use(stage.middleware());

// --------------------- /start Command ---------------------

bot.start(async (ctx) => {
  const telegramId = ctx.from.id;
  try {
    const user = await sqliteDB.getUserByTelegramId(telegramId);
    if (user) {
      await ctx.reply('✅ You are already registered. Use /help to see available commands.');
      await sendMainMenu(ctx);
    } else {
      ctx.scene.enter('registration');
    }
  } catch (error) {
    await ctx.reply('❌ An error occurred. Please try again later.');
    logger.error(`Error checking registration for Telegram ID ${telegramId}:`, error);
  }
});

// --------------------- Global Callback Query Handler ---------------------

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const telegramId = ctx.from.id;

  logger.info(`Global Callback Query Received: ${data} from Telegram ID ${telegramId}`);

  try {
    await ctx.answerCbQuery(); // Prevent timeout

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
      default:
        logger.warn(`Unknown action received: ${data} from Telegram ID ${telegramId}`);
        await ctx.reply('⚠️ *Unknown action.* Please try again.', { parse_mode: 'Markdown' });
    }
  } catch (error) {
    logger.error(`Error handling callback query '${data}' for Telegram ID ${telegramId}:`, error);
    await ctx.reply('❌ An error occurred while processing your request. Please try again later.');
  }
});

// --------------------- Withdrawal Input Handlers ---------------------

bot.on('text', async (ctx) => {
  const telegramId = ctx.from.id;
  const user = await sqliteDB.getUserByTelegramId(telegramId);

  if (!user) {
    await ctx.reply('❌ You are not registered. Please use /start to register your wallet address.');
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
      await ctx.reply('🔄 *Processing your ETH withdrawal...*\n\nPlease wait while we complete your transaction.', {
        parse_mode: 'Markdown',
      });

      const txHash = await withdrawETH(user.wallet_address, amount);

      const updatedEthBalance = parseFloat((user.eth_balance - amount).toFixed(6));
      await sqliteDB.updateUserEthBalance(telegramId, updatedEthBalance);

      await ctx.reply(
        `✅ You have withdrawn *${amount} ETH*.\n\n*Transaction Hash:* [${txHash}](https://sepolia.etherscan.io/tx/${txHash})\n\n*Your new ETH balance:* ${updatedEthBalance} ETH`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      logger.info(`User ${telegramId} withdrew ${amount} ETH. Transaction Hash: ${txHash}`);

      ctx.session.state = null;
      await ctx.scene.leave();
      await sendMainMenu(ctx);
    } catch (error) {
      await ctx.reply('❌ Failed to process your ETH withdrawal. Please try again later.');
      logger.error(`Failed ETH withdrawal for Telegram ID ${telegramId}:`, error);
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
      await ctx.reply('🔄 *Processing your USDC withdrawal...*\n\nPlease wait while we complete your transaction.', {
        parse_mode: 'Markdown',
      });

      const txHash = await withdrawUSDC(user.wallet_address, amount);

      const updatedUsdcBalance = parseFloat((user.usdc_balance - amount).toFixed(6));
      await sqliteDB.updateUserUsdcBalance(telegramId, updatedUsdcBalance);

      await ctx.reply(
        `✅ You have withdrawn *${amount} USDC*.\n\n*Transaction Hash:* [${txHash}](https://sepolia.etherscan.io/tx/${txHash})\n\n*Your new USDC balance:* ${updatedUsdcBalance} USDC`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );

      logger.info(`User ${telegramId} withdrew ${amount} USDC. Transaction Hash: ${txHash}`);

      ctx.session.state = null;
      await ctx.scene.leave();
      await sendMainMenu(ctx);
    } catch (error) {
      await ctx.reply('❌ Failed to process your USDC withdrawal. Please try again later.');
      logger.error(`Failed USDC withdrawal for Telegram ID ${telegramId}:`, error);
    }
  } else {
    await ctx.reply(
      '⚠️ *Unrecognized command or state.* Please use the main menu or /help for assistance.',
      { parse_mode: 'Markdown' }
    );
  }
});

// --------------------- Deposit Monitoring ---------------------

const usdcDepositAbi = ['event Transfer(address indexed from, address indexed to, uint256 value)'];
const usdcDepositContract = new ethers.Contract(process.env.USDC_CONTRACT_ADDRESS, usdcDepositAbi, provider);
const poolAddressLower = process.env.POOL_ADDRESS.toLowerCase();

usdcDepositContract.on('Transfer', async (from, to, value, event) => {
  try {
    if (to.toLowerCase() === poolAddressLower) {
      const usdcAmount = parseFloat(ethers.utils.formatUnits(value, 6));
      logger.info(`📥 USDC Deposit Received: ${usdcAmount} USDC from ${from}`);

      const query = `SELECT telegram_id FROM users WHERE wallet_address = ?`;
      sqliteDB.db.get(query, [from], async (err, row) => {
        if (err) {
          logger.error(`Error fetching user for USDC deposit from ${from}:`, err);
          return;
        }
        if (!row) {
          logger.warn(`No user found with wallet address ${from} for USDC deposit.`);
          return;
        }
        const telegramId = row.telegram_id;
        const user = await sqliteDB.getUserByTelegramId(telegramId);
        if (!user) {
          logger.warn(`User with Telegram ID ${telegramId} not found.`);
          return;
        }
        const updatedUsdcBalance = parseFloat((user.usdc_balance + usdcAmount).toFixed(6));
        await sqliteDB.updateUserUsdcBalance(telegramId, updatedUsdcBalance);

        await bot.telegram.sendMessage(
          telegramId,
          `📥 *Deposit Received!*\n\nYou have received *${usdcAmount} USDC*.\n\n*Updated Balances:*\n- ETH: ${user.eth_balance} ETH\n- USDC: ${updatedUsdcBalance} USDC`,
          { parse_mode: 'Markdown' }
        );
        logger.info(`Updated USDC balance for Telegram ID ${telegramId}: ${updatedUsdcBalance} USDC`);
      });
    }
  } catch (error) {
    logger.error('Error processing USDC deposit:', error);
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
              logger.error(`Error fetching user for ETH deposit from ${tx.from}:`, err);
              return;
            }
            if (!row) {
              logger.warn(`No user found with wallet address ${tx.from} for ETH deposit.`);
              return;
            }
            const telegramId = row.telegram_id;
            const user = await sqliteDB.getUserByTelegramId(telegramId);
            if (!user) {
              logger.warn(`User with Telegram ID ${telegramId} not found.`);
              return;
            }
            const updatedEthBalance = parseFloat((user.eth_balance + ethAmount).toFixed(6));
            await sqliteDB.updateUserEthBalance(telegramId, updatedEthBalance);

            await bot.telegram.sendMessage(
              telegramId,
              `📥 *Deposit Received!*\n\nYou have received *${ethAmount} ETH*.\n\n*Updated Balances:*\n- ETH: ${updatedEthBalance} ETH\n- USDC: ${user.usdc_balance} USDC`,
              { parse_mode: 'Markdown' }
            );
            logger.info(`Updated ETH balance for Telegram ID ${telegramId}: ${updatedEthBalance} ETH`);
          });
        }
      }
    }
  } catch (error) {
    logger.error('Error processing ETH deposits:', error);
  }
});

// --------------------- Dual-Mode Webhook or Polling ---------------------

const MODE = process.env.MODE || 'polling'; // 'webhook' for hosting, 'polling' for local
if (MODE === 'webhook') {
  const app = express();
  app.use(express.json());

  // Endpoint for Telegram updates
  const path = `/webhook/${bot.token}`;
  app.use(path, (req, res) => {
    bot.handleUpdate(req.body, res);
  });

  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`🚀 Bot is running in webhook mode on port ${PORT}`);
  });

  // Set your external webhook URL in your .env
  // e.g., WEBHOOK_URL=https://yourapp.onrender.com
  bot.telegram.setWebhook(`${process.env.WEBHOOK_URL}${path}`).catch((err) => {
    logger.error('❌ Error setting webhook:', err);
  });
} else {
  // Launch in polling mode (local environment)
  bot
    .launch()
    .then(() => {
      logger.info('✅ Bot is running in polling mode...');
      logger.info('✅ Deposit monitoring is active.');
    })
    .catch((error) => {
      logger.error('❌ Error launching the bot in polling mode:', error);
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
