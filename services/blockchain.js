// services/blockchain.js

const { ethers } = require('ethers');
const logger = require('./logger');
require('dotenv').config();

// Initialize Provider
const provider = new ethers.providers.InfuraProvider('sepolia', process.env.INFURA_PROJECT_ID);

// USDC Contract Setup
const usdcAddress = process.env.USDC_CONTRACT_ADDRESS;
const usdcAbi = [
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
];
const usdcContract = new ethers.Contract(usdcAddress, usdcAbi, provider);

// Pool Address (Where USDC Bets Go)
const poolAddress = process.env.POOL_ADDRESS;

// Pool Signer (Pool must have a private key to perform transfers)
const poolPrivateKey = process.env.POOL_PRIVATE_KEY;
if (!poolPrivateKey) {
    logger.error('POOL_PRIVATE_KEY is not set in the environment variables.');
    process.exit(1);
}
const poolWallet = new ethers.Wallet(poolPrivateKey, provider);
const usdcWithPoolSigner = usdcContract.connect(poolWallet);

/**
 * Fetch USDC balance for the pool.
 * @returns {Promise<number>} - USDC balance in the pool.
 */
const getPoolUsdcBalance = async () => {
    try {
        const balance = await usdcContract.balanceOf(poolAddress);
        const formattedBalance = parseFloat(ethers.utils.formatUnits(balance, 6)); // USDC has 6 decimals
        logger.info(`Pool USDC Balance: ${formattedBalance} USDC`);
        return formattedBalance;
    } catch (error) {
        logger.error('Error fetching pool USDC balance:', error);
        throw error;
    }
};

/**
 * Transfer USDC from the pool to a user's wallet.
 * @param {string} to - Recipient's Ethereum address.
 * @param {number} amount - Amount of USDC to transfer.
 * @returns {Promise<ethers.providers.TransactionResponse>} - Transaction response.
 */
const transferUsdcToUser = async (to, amount) => {
    try {
        const tx = await usdcWithPoolSigner.transfer(to, ethers.utils.parseUnits(amount.toString(), 6));
        logger.info(`USDC transfer transaction sent: ${tx.hash}`);
        await tx.wait();
        logger.info(`USDC transfer transaction confirmed: ${tx.hash}`);
        return tx;
    } catch (error) {
        logger.error(`Error transferring USDC to ${to}:`, error);
        throw error;
    }
};

/**
 * Fetch ETH balance for the pool.
 * @returns {Promise<number>} - ETH balance in the pool.
 */
const getPoolEthBalance = async () => {
    try {
        const balance = await provider.getBalance(poolAddress);
        const formattedBalance = parseFloat(ethers.utils.formatEther(balance));
        logger.info(`Pool ETH Balance: ${formattedBalance} ETH`);
        return formattedBalance;
    } catch (error) {
        logger.error('Error fetching pool ETH balance:', error);
        throw error;
    }
};

/**
 * Transfer ETH from the pool to a user's wallet.
 * @param {string} to - Recipient's Ethereum address.
 * @param {number} amount - Amount of ETH to transfer.
 * @returns {Promise<ethers.providers.TransactionResponse>} - Transaction response.
 */
const transferEthToUser = async (to, amount) => {
    try {
        const tx = await poolWallet.sendTransaction({
            to,
            value: ethers.utils.parseEther(amount.toString()),
        });
        logger.info(`ETH transfer transaction sent: ${tx.hash}`);
        await tx.wait();
        logger.info(`ETH transfer transaction confirmed: ${tx.hash}`);
        return tx;
    } catch (error) {
        logger.error(`Error transferring ETH to ${to}:`, error);
        throw error;
    }
};

module.exports = {
    getPoolUsdcBalance,
    transferUsdcToUser,
    getPoolEthBalance,
    transferEthToUser,
};
