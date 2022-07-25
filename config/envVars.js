const dotenv = require('dotenv');

// require and configure dotenv, will load vars in .env in PROCESS.ENV
dotenv.config();

module.exports.getEnvVars = () => ({
    botToken: process.env.BOT_TOKEN,
    kachingSecret: process.env.KACHING_SECRET,
    failedRaffleTree: process.env.FAILED_RAFFLE_TREE,
    passedRaffleTree: process.env.PASSED_RAFFLE_TREE,
    raffleContractTree: process.env.RAFFLE_CONTRACT_TREE,
    raffleTokenV1: process.env.RAFFLE_TOKEN_V1,
    defaultRaffleImage: process.env.DEFAULT_RAFFLE_IMAGE,
    chatId: process.env.CHAT_ID,
});