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

  console.log("在 [%d] 收到來自使用者 [%d] / 粉絲頁 [%d] 送來的訊息:",
    timeOfMessage, senderID, recipientID);
  console.log(JSON.stringify(message));

  var messageId = message.mid;

  // 訊息有 2 部份︰文字 / 附檔
  var messageText = message.text;
  var messageAttachments = message.attachments;

  if (messageText) {
    switch (messageText) {
      default:
        sendTextMessage(senderID, messageText);
    }
  } else if (messageAttachments) {
    sendTextMessage(senderID, "收到使用者丟過來的附檔");
  }
}

/*
 * 使用 SendAPI 傳送文字訊息
 */
function sendTextMessage(recipientId, messageText) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      text: messageText
    }
  };

  console.log("messageData", messageData);

  callSendAPI(messageData);
}

/*
 * 發送訊息的主體
 */
function callSendAPI(messageData) {
  request({
    uri: 'https://graph.facebook.com/v2.6/me/messages',
    qs: { access_token: PAGE_ACCESS_TOKEN },
    method: 'POST',
    json: messageData

  }, function (error, response, body) {
    if (!error && response.statusCode == 200) {
      var recipientId = body.recipient_id;
      var messageId = body.message_id;

      console.log("訊息已成功發送，Message ID: [%s], Recipient ID: [%s]",
        messageId, recipientId);
    } else {
      console.error("Unable to send message.");
      console.error(response);
      console.error(error);
    }
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

/*
 * 手動寄送 message 給指定使用者
 */
app.get('/sendMessageManual', function(req, res) {
  var userId = req.query.user_id;
  var messageText = req.query.message;

  console.log("手動寄送訊息: user id [%s], message [%s]", userId, messageText);

  var messageData = {
    recipient: {
      id: userId
    },
    message: {
      text: messageText
    }
  };

  callSendAPI(messageData);
  res.sendStatus(200);
});

// 啓動 Bot API Service
app.listen(app.get('port'), function() {
  console.log('Node app is running on port', app.get('port'));
});

module.exports = app;
