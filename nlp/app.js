'use strict';

const
  bodyParser = require('body-parser'),
  config = require('config'),
  crypto = require('crypto'),
  express = require('express'),
  https = require('https'),
  request = require('request');

var app = express();

app.set('port', process.env.PORT || 5000);
app.use(bodyParser.json({ verify: verifyRequestSignature }));
app.use(express.static('public'));

/*
 * 以下為 FB Bot 會需要的認証資訊︰
 *
 * 1. appSecret
 * 2. validationToken
 * 3. appSecret
 */

// App Secret can be retrieved from the App Dashboard
const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ?
  process.env.MESSENGER_APP_SECRET :
  config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
  (process.env.MESSENGER_VALIDATION_TOKEN) :
  config.get('validationToken');

// Generate a page access token for your page from the App Dashboard
const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
  (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
  config.get('pageAccessToken');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN)) {
  console.error("Missing config values");
  process.exit(1);
}

/*
 * 驗証每一筆 FB 的 callback 簽章是否正確
 *
 * Ref: https://developers.facebook.com/docs/graph-api/webhooks#setup
 */
function verifyRequestSignature(req, res, buf) {
  var signature = req.headers["x-hub-signature"];

  if (!signature) {
    // For testing, let's log an error. In production, you should throw an
    // error.
    console.error("Couldn't validate the signature.");
  } else {
    var elements = signature.split('=');
    var method = elements[0];
    var signatureHash = elements[1];

    var expectedHash = crypto.createHmac('sha1', APP_SECRET)
                        .update(buf)
                        .digest('hex');

    if (signatureHash != expectedHash) {
      throw new Error("Couldn't validate the request signature.");
    }
  }
}

/*
 * 供 FB webhook 註冊使用
 *
 * Note: VALIDATION_TOKEN 為我們自己設定的認証密碼
 */
app.get('/webhook', function(req, res) {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === VALIDATION_TOKEN) {
    console.log("Validating webhook");
    res.status(200).send(req.query['hub.challenge']);
  } else {
    console.error("Failed validation. Make sure the validation tokens match.");
    res.sendStatus(403);
  }
});

/*
 * 處理使用者送來旳資訊
 * 1. 所有 FB 送來的 message calbackk 皆為 POST
 * 2. 格式基本相同，只是不同類型，細部欄位內容不一樣
 *
 * Ref: https://developers.facebook.com/docs/messenger-platform/webhook-reference#format
 */
app.post('/webhook', function (req, res) {
  var data = req.body;

  // 確定 message 來源是 FB page subscription
  if (data.object != 'page') {
    res.sendStatus(200);
  }

  // 巡覽每個 data entry，一個 data entry 下可能有多筆訊息
  data.entry.forEach(function(pageEntry) {
    var pageID = pageEntry.id;
    var timeOfEvent = pageEntry.time;

    // 巡覽每個收到的訊息，做出回應
    pageEntry.messaging.forEach(function(messagingEvent) {
      if (messagingEvent.message) { // 接到使用者送來的訊息
        receivedMessage(messagingEvent);
      } else if (messagingEvent.delivery) { // 回訊後，收到 FB 回傳的確認資訊
        receivedDeliveryConfirmation(messagingEvent);
      } else {
        console.log("Webhook 收到不知道怎麼處理的 messagingEvent: ", messagingEvent);
      }
    });
  });

  // 20 秒內必需送出 200 回應
  res.sendStatus(200);
});

// 自幹型 session db
// Ref: http://blog.techbridge.cc/2016/07/02/ChatBot-with-Wit/
const sessions = {};

const findOrCreateSession = (fbid) => {
  let sessionId;
  // Let's see if we already have a session for the user fbid
  Object.keys(sessions).forEach(k => {
    if (sessions[k].fbid === fbid) {
      // Yep, got it!
      sessionId = k;
    }
  });
  if (!sessionId) {
    // No session found for user fbid, let's create a new one
    sessionId = new Date().toISOString();
    sessions[sessionId] = {fbid: fbid, context: {}};
  }

  return sessionId;
};

/*
 * NLP 相關︰wit.ai
 *
 * Ref: https://wit.ai
 */
let Wit = require('node-wit').Wit;

const firstEntityValue = (entities, entity) => {
  const val = entities && entities[entity] &&
    Array.isArray(entities[entity]) &&
    entities[entity].length > 0 &&
    entities[entity][0].value
  ;
  if (!val) {
    return null;
  }
  return typeof val === 'object' ? val.value : val;
};

const actions = {
  send(request, response) {
    const {sessionId, context, entities} = request;
    const {text, quickreplies} = response;

    // find out user id
    const recipientId = sessions[sessionId].fbid;
    if (!recipientId) {
      console.error('Oops! Couldn\'t find user for session:', sessionId);
      return Promise.resolve();
    }

    // 這邊需要判斷要回傳的訊息是否為查詢結果
    // 若 context 中帶有 newsResult 那就是要回傳查詢結果
    // 因此就要呼叫 sendNewsMessagePromise() 來回傳 GenericMessage
    if (context.newsResult) {
      return sendTextMessagePromise(recipientId, context.newsResult)
        .then(() => {})
        .catch((err) => {
          console.error('Oops! An error occurred while forwarding the response to', recipientId, ':', err.stack || err);
        });
    } else {
      return sendTextMessagePromise(recipientId, text)
        .then(() => {})
        .catch((err) => {
          console.error('Oops! An error occurred while forwarding the response to', recipientId, ':', err.stack || err);
        });
    }
  },
  getForecast({context, entities}) {
    return new Promise(function(resolve, reject) {
      var location = firstEntityValue(entities, 'location')
      if (location) {
        context.forecast = 'sunny in ' + location; // we should call a weather API here
        delete context.missingLocation;
      } else {
        context.missingLocation = true;
        delete context.forecast;
      }
      return resolve(context);
    });
  },
};

/*
 * wit.ai 的設定，需要 wit.ai story 的 Access Token
 */
const wit = new Wit({
  accessToken: '',
  actions,
});

/*
 * Message Event
 * 接收到的訊息處理
 *
 * Ref: https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-received
 */
function receivedMessage(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfMessage = event.timestamp;
  var message = event.message;

  console.log("在 [%d] 收到來自使用者 [%d] / 粉絲頁 [%d] 送來的訊息:", timeOfMessage, senderID, recipientID);
  console.log(JSON.stringify(message));

  // 儲存 session
  var sessionId = findOrCreateSession(senderID);

  // 先送出等待訊息給 user
  sendTypingOnMessage(senderID);

  // NLP engine 處理
  const text = event.message.text;
  wit.runActions (
    sessionId, // 使用者的 session id
    text, // 使用者傳來的訊息
    sessions[sessionId].context // 使用者的 context
  ).then((context) => {
    // Our bot did everything it has to do.
    // Now it's waiting for further messages to proceed.
    console.log('Waiting for next user messages');
    // Updating the user's current session state
    sessions[sessionId].context = context;
  }).catch((err) => {
    console.error('Oops! Got an error from Wit: ', err.stack || err);
  });
}

/*
 * 使用 SendAPI 傳送等待訊息
 */
function sendTypingOnMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    sender_action: "typing_on"
  };

  //console.log("messageData", messageData);
  return callSendApiPromise(messageData);
}

/*
 * 使用 SendAPI 傳送文字訊息
 */
function sendTextMessagePromise(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText
    }
  };

  //console.log("messageData", messageData);
  return callSendApiPromise(messageData);
}

/*
 * 發送訊息的主體
 */
function callSendApiPromise(messageData) {
  return new Promise((resolve, reject) => {
    request({
      uri: 'https://graph.facebook.com/v2.6/me/messages',
      qs: { access_token: PAGE_ACCESS_TOKEN },
      method: 'POST',
      json: messageData

    }, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        var recipientId = body.recipient_id;
        var messageId = body.message_id;

        console.log("訊息已成功發送，Message ID: [%s], Recipient ID: [%s]", messageId, recipientId);
        resolve();
      } else {
        console.error("Unable to send message.");
        console.error(response);
        console.error(error);
        reject(new Error("Unable to send message."));
      }
    });
  });
}

/*
 * 處理 FB 送來的訊息發送確認資訊
 *
 * Ref: https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 */
function receivedDeliveryConfirmation(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var delivery = event.delivery;
  var messageIDs = delivery.mids;
  var watermark = delivery.watermark;
  var sequenceNumber = delivery.seq;

  if (messageIDs) {
    messageIDs.forEach(function(messageID) {
      console.log("Message ID [%s] 訊息已發送", messageID);
    });
  }

  console.log("timestamp [%d] 之前的所有訊息已發送", watermark);
}

// 啓動 Bot API Service
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
