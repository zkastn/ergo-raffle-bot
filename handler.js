const AWS = require("aws-sdk");
const express = require("express");
const serverless = require("serverless-http");
const axios = require("axios");
const wasm = require('ergo-lib-wasm-nodejs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const RAFFLES_TABLE = process.env.RAFFLES_TABLE;
const KACHING_SECRET = process.env.KACHING_SECRET;
const FAILED_RAFFLE_TREE = process.env.FAILED_RAFFLE_TREE;
const PASSED_RAFFLE_TREE = process.env.PASSED_RAFFLE_TREE;
const RAFFLE_CONTRACT_TREE = process.env.RAFFLE_CONTRACT_TREE;
const RAFFLE_TOKEN_V1 = process.env.RAFFLE_TOKEN_V1;
const DEFAULT_RAFFLE_IMAGE = process.env.DEFAULT_RAFFLE_IMAGE;
const NANO_ERGS = 1000000000;
const TOTAL_TOKENS =1000000000;
const HOUR_BLOCKS_COUNT = 30;
const DAY_BLOCK_COUNT = 720;
const MINUTE_BLOCK_COUNT = 0.5;

//Set up DynamoDB
const dynamoDbClientParams = {};
const dynamoDbClient = new AWS.DynamoDB.DocumentClient(dynamoDbClientParams);


//Set up express app
const app = express();
app.use(express.json());

//DEFAULT TELEGRAM CHAT OPTIONS
var tg_bot_options = {
  method: 'POST',
  url: `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`,
  headers: {Accept: 'application/json', 'Content-Type': 'application/json'},
  data: {
    photo: DEFAULT_RAFFLE_IMAGE,
    caption: 'Testing',
    parse_mode: 'Markdown',
    disable_web_page_preview: true,
    disable_notification: false,
    reply_to_message_id: null,
    chat_id: process.env.CHAT_ID
  }
};



app.post('/kaching/:secret', async (req, res) => {
  const short_id = (id) => {
    return `${id.slice(0,4)}...${id.slice(-4,id.length)}`
  }
  const display_time = (remaining_blocks) => {
    const to_str_result = (amount, unit) => {
      const plural_sign = (amount > 1 ? "s": "")
      return `${amount} ${unit}${plural_sign} to Go`
    }
    var remaining_block = Math.abs(remaining_blocks);
    const days = Math.floor(remaining_block / DAY_BLOCK_COUNT);
    remaining_block -= days * DAY_BLOCK_COUNT;
    const hours = Math.floor(remaining_block / HOUR_BLOCKS_COUNT);
    remaining_block -= hours * HOUR_BLOCKS_COUNT;
    const minutes = Math.floor(remaining_block / MINUTE_BLOCK_COUNT);
    if(days > 0) return to_str_result(days, "Day")
    if(hours > 0) return to_str_result(hours, "Hour")
    return to_str_result(minutes, "Minute")
  }
  if(req.params.secret === KACHING_SECRET){
    const { transaction, subscriber, event } = req.body;
    console.log(transaction)
    try {
      const activeRaffleBox = transaction.outputs.filter(obj=> obj.ergoTree == RAFFLE_CONTRACT_TREE)[0];
      if (activeRaffleBox) {
        const currentHeight = activeRaffleBox.creationHeight
        var raffleToken = activeRaffleBox.assets.filter(obj => obj.tokenId != RAFFLE_TOKEN_V1)[0];
        const raffleId = raffleToken.tokenId
        var name = `Raffle ${short_id(raffleId)}`;
        var picture = DEFAULT_RAFFLE_IMAGE;
        try {
          var result = await axios.get(`https://api.ergoraffle.com/api/raffle/${raffleId}`);
          name = result.data.name === undefined ? name : result.data.name;
          picture = result.data.picture[0] === undefined ? picture : result.data.picture[0];
        } catch (error) {
          console.log(error);
        }
        if(picture){
          tg_bot_options.data.photo = picture;
        }
        var raffleStats = {};
        var keys = ["charity", "service", "price", "goal", "deadline", "soldTickets"]
        var R4 = activeRaffleBox.additionalRegisters.R4.serializedValue ? activeRaffleBox.additionalRegisters.R4.serializedValue:activeRaffleBox.additionalRegisters.R4;
        var values = wasm.Constant.decode_from_base16(R4).to_i64_str_array().map(cur => parseInt(cur))//.renderedValue.slice(2, -1).split(',')
        keys.forEach((key, i) => raffleStats[key] = values[i]);
        var timeRemaining = (raffleStats.deadline - currentHeight)
        try {
          const dbParams = {
            TableName: RAFFLES_TABLE,
            Key: {
              raffleId: raffleId,
            },
          };
          const { Item } = await dynamoDbClient.get(dbParams).promise();
          if (Item) {
            var { thisRaffleId, firstSaleEvent, thirtyPercentEvent, fiftyPercentEvent, ninetyPercentEvent,fundedEvent,endEvent } = Item;
            console.log(Item)
          } else {
            console.log("raffleId not in db adding now..")
            var params = {
              TableName: RAFFLES_TABLE,
              Item: {
                raffleId: raffleId,
                firstSaleEvent: false,
                thirtyPercentEvent: false, // 30% threshold
                fiftyPercentEvent: false, // 50% threshold
                ninetyPercentEvent: false, // 90% threshold
                fundedEvent: false,
                endEvent: false
              },
            };
            try {
              await dynamoDbClient.put(params).promise();
              console.log(`raffle ${raffleId} has been added to db`)
            } catch (error) {
              console.log(error);
            }
          }
        } catch (error) {
          console.log(error);
        }
        if (timeRemaining > 0) {
          //Raffle is still live
          var goal = raffleStats.goal / NANO_ERGS;
          var price = raffleStats.price /NANO_ERGS;
          var soldTickets = TOTAL_TOKENS - raffleToken.amount;
          if (soldTickets > 0 ) {
            //ALERT: +1 TICKET IS SOLD
            var percentFunded = ((soldTickets*price)/ goal) * 100 //Math.round(((soldTickets/goal)*100 + Number.EPSILON) * 100) / 100;
            if(percentFunded<30){
              if(!firstSaleEvent){
                tg_bot_options.data.caption = `🚨 *FIRST SALE* 🚨 \n\n*Raffle:* ${name}\n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId}) \n*Tickets sold:* ${soldTickets}\n*Goal:* ${goal} ERG (${goal/price} Tickets)\n*Time Remaining:* ${display_time(timeRemaining)}   \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
                try {
                  let res = await axios.request(tg_bot_options);
                  console.log(res)
                } catch (error) {
                  console.log(error);
                }
                var params = {
                  TableName: RAFFLES_TABLE,
                  Item: {
                    raffleId: raffleId,
                    firstSaleEvent: true,
                    thirtyPercentEvent: false, // 30% threshold
                    fiftyPercentEvent: false, // 50% threshold
                    ninetyPercentEvent: false, // 90% threshold
                    fundedEvent: false,
                    endEvent: false
                  },
                };
                try {
                  await dynamoDbClient.put(params).promise();
                  console.log(`raffle ${raffleId} db has been updated`)
                } catch (error) {
                  console.log(error);
                }
              }
            }
            else if (percentFunded >= 30.0 && percentFunded < 50.0) {
              //ALERT: +30% TICKETS ARE SOLD
              
              if(!thirtyPercentEvent){
                tg_bot_options.data.caption = `👀 *JUST PASSED 30% FUNDING!* 👀   \n\n*Raffle:* ${name}  \n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId})   \n*Tickets sold:* ${soldTickets}   \n*Goal:* ${goal} ERG (${goal/price} Tickets)   \n*Time Remaining:* ${display_time(timeRemaining)}   \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
                try {
                  let res = await axios.request(tg_bot_options);
                } catch (error) {
                  console.log(error);
                }
                var params = {
                  TableName: RAFFLES_TABLE,
                  Item: {
                    raffleId: raffleId,
                    firstSaleEvent: true,
                    thirtyPercentEvent: true, // 30% threshold
                    fiftyPercentEvent: false, // 50% threshold
                    ninetyPercentEvent: false, // 90% threshold
                    fundedEvent: false,
                    endEvent: false
                  },
                };
                try {
                  await dynamoDbClient.put(params).promise();
                  console.log(`raffle ${raffleId} db has been updated`)
                } catch (error) {
                  console.log(error);
                }
              }
            } else if (percentFunded >= 50.0 && percentFunded < 90.0) {
              if(!fiftyPercentEvent){
                tg_bot_options.data.caption = `👀 *JUST PASSED 50% FUNDING!* 👀    \n\n*Raffle:* ${name}   \n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId})   \n*Tickets sold:* ${soldTickets}   \n*Goal:* ${goal} ERG (${goal/price} Tickets)   \n*Time Remaining:* ${display_time(timeRemaining)}   \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
                try {
                  let res = await axios.request(tg_bot_options);
                } catch (error) {
                  console.log(error);
                }
                var params = {
                  TableName: RAFFLES_TABLE,
                  Item: {
                    raffleId: raffleId,
                    firstSaleEvent: true,
                    thirtyPercentEvent: true, // 30% threshold
                    fiftyPercentEvent: true, // 50% threshold
                    ninetyPercentEvent: false, // 90% threshold
                    fundedEvent: false,
                    endEvent: false
                  },
                };
                try {
                  await dynamoDbClient.put(params).promise();
                  console.log(`raffle ${raffleId} db has been updated`)
                } catch (error) {
                  console.log(error);
                }
              }
              
            } else if (percentFunded >= 90.0 && percentFunded < 100.0) {
              if(!ninetyPercentEvent){
                tg_bot_options.data.caption = `👀*JUST PASSED 90% FUNDING!*👀  \n\n*Raffle:* ${name}   \n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId})   \n*Tickets sold:* ${soldTickets}   \n*Goal:* ${goal} ERG (${goal/price} Tickets)   \n*Time Remaining:* ${display_time(timeRemaining)}   \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
                try {
                  let res = await axios.request(tg_bot_options);
                } catch (error) {
                  console.log(error);
                }
                var params = {
                  TableName: RAFFLES_TABLE,
                  Item: {
                    raffleId: raffleId,
                    firstSaleEvent: true,
                    thirtyPercentEvent: true, // 30% threshold
                    fiftyPercentEvent: true, // 50% threshold
                    ninetyPercentEvent: true, // 90% threshold
                    fundedEvent: false,
                    endEvent: false
                  },
                };
                try {
                  await dynamoDbClient.put(params).promise();
                  console.log(`raffle ${raffleId} db has been updated`)
                } catch (error) {
                  console.log(error);
                }
              }
            } else if (percentFunded >= 100.0) {
                //ALERT: RAFFLE IS FUNDED!
                if(!fundedEvent){
                  tg_bot_options.data.caption = `🎉🎉*JUST PASSED 100% FUNDING!*🎉🎉   \n\n*Raffle:* ${name}   \n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId})   \n*Tickets sold:* ${soldTickets}   \n*Goal:* ${goal} ERG (${goal/price} Tickets)   \n*Time Remaining:* ${display_time(timeRemaining)}   \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
                  try {
                    let res = await axios.request(tg_bot_options);
                  } catch (error) {
                    console.log(error);
                  }
                  var params = {
                    TableName: RAFFLES_TABLE,
                    Item: {
                      raffleId: raffleId,
                      firstSaleEvent: true,
                      thirtyPercentEvent: true, // 30% threshold
                      fiftyPercentEvent: true, // 50% threshold
                      ninetyPercentEvent: true, // 90% threshold
                      fundedEvent: true,
                      endEvent: false
                    },
                  };
                  try {
                    await dynamoDbClient.put(params).promise();
                    console.log(`raffle ${raffleId} db has been updated: 100% funded`)
                  } catch (error) {
                    console.log(error);
                  }
                }
            }
          }
        }
      }    
      else{
        var discardRaffleBox = transaction.outputs.filter(obj=> obj.ergoTree == PASSED_RAFFLE_TREE)[0];
        if(discardRaffleBox){
          var raffleToken = discardRaffleBox.assets.filter(obj => obj.tokenId != RAFFLE_TOKEN_V1)[0];
        }else{
          discardRaffleBox = transaction.outputs.filter(obj=> obj.ergoTree == FAILED_RAFFLE_TREE)[0];
          raffleToken = discardRaffleBox.assets.filter(obj => obj.tokenId != RAFFLE_TOKEN_V1)[0];
        }
        var raffleId = raffleToken.tokenId;
        var name = `Raffle ${raffleId}`
        var picture = DEFAULT_RAFFLE_IMAGE;
        try {
          var result = await axios.get(`https://api.ergoraffle.com/api/raffle/${raffleId}`);
          name = result.data.name;
          picture = result.data.picture[0];
        } catch (error) {
          console.log(error);
        }
        if(picture){
          tg_bot_options.data.photo = picture;
        }
        var raffleStats = {};
        var keys = ["charity", "service", "price", "goal", "deadline", "soldTickets"];
        var R4 = discardRaffleBox.additionalRegisters.R4.serializedValue ? discardRaffleBox.additionalRegisters.R4.serializedValue : discardRaffleBox.additionalRegisters.R4;
        var values = wasm.Constant.decode_from_base16(R4).to_i64_str_array().map(cur => parseInt(cur))//.renderedValue.slice(2, -1).split(',')
        keys.forEach((key, i) => raffleStats[key] = values[i]);
        keys.forEach((key, i) => raffleStats[key] = parseInt(values[i]));
        var goal = raffleStats.goal / NANO_ERGS;
        var price = raffleStats.price /NANO_ERGS;
        var soldTickets = TOTAL_TOKENS - raffleToken.amount;
        var percentFunded = ((soldTickets*price)/ goal) * 100
        try {
          const dbParams = {
            TableName: RAFFLES_TABLE,
            Key: {
              raffleId: raffleId,
            },
          };
          console.log(dbParams)
          const { Item } = await dynamoDbClient.get(dbParams).promise();
          if (Item) {
            var { thisRaffleId, firstSaleEvent, thirtyPercentEvent, fiftyPercentEvent, ninetyPercentEvent,fundedEvent,endEvent } = Item;
            console.log(Item)
          } else {
            console.log("raffleId not in db adding now..")
            var params = {
              TableName: RAFFLES_TABLE,
              Item: {
                raffleId: raffleId,
                firstSaleEvent: false,
                thirtyPercentEvent: false, // 30% threshold
                fiftyPercentEvent: false, // 50% threshold
                ninetyPercentEvent: false, // 90% threshold
                fundedEvent: false,
                endEvent: true
              },
            };
            try {
              await dynamoDbClient.put(params).promise();
              console.log(`raffle ${raffleId} has been added to db`)
            } catch (error) {
              console.log(error);
            }
          }
        } catch (error) {
          console.log(error);
        }
        if(!endEvent){
            console.log(`ALERT: THE RAFFLE ${raffleId} HAS ENDED!!`)
            try {
              var txRes = await axios.get(`https://api.ergoraffle.com/api/raffle/${raffleId}/transaction`)
              var raffleRes = txRes.data;
              var successfulRaffle =  raffleRes.items.filter(obj=> obj.type === "winner")[0];
            } catch (error) {
              console.log(error);
            }
            var params = {
              TableName: RAFFLES_TABLE,
              Item: {
                raffleId: raffleId,
                firstSaleEvent: true,
                thirtyPercentEvent: true,
                fiftyPercentEvent: true,
                ninetyPercentEvent: true,
                fundedEvent: true,
                endEvent: true
              },
            };
            try {
              await dynamoDbClient.put(params).promise();
              console.log(`raffle ${raffleId} db has been updated ENDED`)
            } catch (error) {
              console.log(error);
            }
            if(percentFunded>=100){
              if(successfulRaffle){
                tg_bot_options.data.caption = `💸 *A FULLY FUNDED RAFFLE HAS ENDED* 💸 \n\n*Raffle:* ${name}  \n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId})   \n*Tickets sold:* ${soldTickets} \n*Goal:* ${goal} ERG (${goal/price} Tickets)  \n*Winner:* ${successfulRaffle.address} \n*Payment:* ${successfulRaffle.link}  \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
              }
              else{
                try {
                  //try again
                  var txRes = await axios.get(`https://api.ergoraffle.com/api/raffle/${raffleId}/transaction`)
                  var raffleRes = txRes.data;
                  var successfulRaffle =  raffleRes.items.filter(obj=> obj.type === "winner")[0];
                  console.log(successfulRaffle)
                } catch (error) {
                    console.log(error);
                }
                if(successfulRaffle){
                  tg_bot_options.data.caption = `💸 *A FULLY FUNDED RAFFLE HAS ENDED* 💸 \n\n*Raffle:* ${name}  \n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId})   \n*Tickets sold:* ${soldTickets} \n*Goal:* ${goal} ERG (${goal/price} Tickets)  \n*Winner:* ${successfulRaffle.address} \n*Payment:* ${successfulRaffle.link}  \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
                } else{
                  tg_bot_options.data.caption = `💸 *A FULLY FUNDED RAFFLE HAS ENDED* 💸 \n\n*Raffle:* ${name}  \n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId})   \n*Tickets sold:* ${soldTickets} \n*Goal:* ${goal} ERG (${goal/price} Tickets)  \n*Follow link above to see if you've won!*  \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
                }
              }
              try {
                let res = await axios.request(tg_bot_options);
              } catch (error) {
                console.log(error);
              }
              console.log(successfulRaffle.link);
            }
            else if(percentFunded>0 && percentFunded<100)
            {
              tg_bot_options.data.caption = `🚨 *A RAFFLE HAS FAILED* 🚨  \n\n*Raffle:* ${name}  \n*Link:* [https://ergoraffle.com/raffle/show/${short_id(raffleId)}](https://ergoraffle.com/raffle/show/${raffleId})   \n*Tickets sold:* ${soldTickets} \n*Goal:* ${goal} ERG (${goal/price} Tickets)  \n*Participants are being refunded!*  \n\n(automated with ${"*@kaching\_ergo\_bot*"})`
              try {
                let res = await axios.request(tg_bot_options);
              } catch (error) {
                console.log(error);
              }
              console.log("RAFFLE FAILED")
            }
          }
      }
      res.json({ status: 'Ok' });
    } catch (e) {
      res.json({ error: (e).message });
    }
  }
  else{
    res.json({ message: 'You Shall Not Pass'})
  }
});

app.use((req, res, next) => {
  return res.status(404).json({
    error: "Not Found",
  });
});


module.exports.handler = serverless(app);
