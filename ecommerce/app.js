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
      } else if (messagingEvent.postback) {
        receivedPostback(messagingEvent);
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

   console.log("Received message for user %d and page %d at %d with message:",
     senderID, recipientID, timeOfMessage);
   console.log(JSON.stringify(message));

   var messageId = message.mid;

   // You may get a text or attachment but not both
   var messageText = message.text;
   var messageAttachments = message.attachments;

   if (messageText) {
     // 依照訊息，做出回應
     switch (messageText) {
       case '試手氣':
         sendImageMessage(senderID);
         break;

       case '萬能的大神':
         sendButtonMessage(senderID);
         break;

       case '型錄':
         sendGenericMessage(senderID);
         break;

       case '收據':
         sendReceiptMessage(senderID);
         break;

       default:
         sendTextMessage(senderID, messageText);
     }
   } else if (messageAttachments) {
     sendTextMessage(senderID, "Message with attachment received");
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
 * image template
 */
function sendImageMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "image",
        payload: {
          url: "http://i.imgur.com/zYIlgBl.png"
        }
      }
    }
  };

  callSendAPI(messageData);
}


/*
 * 選單 templat
 */
function sendButtonMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "button",
          text: "我親愛的子民，請問您想？",
          buttons:[{
            type: "web_url",
            title: "給我看看新的 84 折活動",
            url: "https://tw.buy.yahoo.com/activity/activity950?p=all2-00-151224-2016VIPmember&act=crmB00g01t01"
          },{
            type: "postback",
            title: "給我看看最新的相機",
            payload: "View [型錄]"
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * 型錄 template
 */
function sendGenericMessage(recipientId) {
  var messageData = {
    recipient: {
      id: recipientId
    },
    message: {
      attachment: {
        type: "template",
        payload: {
          template_type: "generic",
          elements: [{
            title: "Canon 5D Mark III 24-70mm 變焦鏡組 (公司貨)",
            subtitle: "6/30 前購買, 申請通過審核後送 LP-E6N 原廠電池 + Canon MG5770 印表機\n2230 萬像素全片幅 + DIGIC 5\n萬像素全片幅 + DIGIC 5\nSD/CF 雙插槽設計\n最高每秒 6 張高速連拍\n61 點高密度網形自動對焦感應器\n",
            item_url: "https://tw.buy.yahoo.com/gdsale/gdsale.asp?gdid=4919020",
            image_url: "https://s.yimg.com/wb/images/97C3516234224ED442B689C9C6737F7CB861FC07",
            buttons: [{
              type: "web_url",
              url: "https://tw.buy.yahoo.com/gdsale/gdsale.asp?gdid=4919020",
              title: "打開此賣場"
            }, {
              type: "postback",
              title: "加入購物車",
              payload: "Payload for first bubble",
            }],
          }, {
            title: "SONY A7 II 24-70mm 變焦鏡組 (平輸中文)",
            subtitle: "送 SD32G + 副電 + 單眼包 + 減壓背帶 + 清潔組 + 保護貼 (贈品已與主件商品包裝一起, 故不再顯示於買就送欄位)",
            item_url: "https://tw.buy.yahoo.com/gdsale/gdsale.asp?gdid=5858008",
            image_url: "https://s.yimg.com/wb/images/A176A536688C28AB6C6C1BC33BF931E0FDF4D3BD",
            buttons: [{
              type: "web_url",
              url: "https://tw.buy.yahoo.com/gdsale/gdsale.asp?gdid=5858008",
              title: "打開此賣場"
            }, {
              type: "postback",
              title: "加入購物車",
              payload: "Payload for second bubble",
            }]
          }]
        }
      }
    }
  };

  callSendAPI(messageData);
}

/*
 * 收據 template
 */
function sendReceiptMessage(recipientId) {
  // Generate a random receipt ID as the API requires a unique ID
  var receiptId = "order" + Math.floor(Math.random()*1000);

  var messageData = {
    recipient: {
      id: recipientId
    },
    message:{
      attachment: {
        type: "template",
        payload: {
          template_type: "receipt",
          recipient_name: "Zheng-Wei Lin",
          order_number: receiptId,
          currency: "TWD",
          payment_method: "Visa 1234",
          timestamp: "1428444852",
          elements: [{
            title: "SONY A7 II 24-70mm 變焦鏡組 (平輸中文)",
            subtitle: "全球首創五軸影像穩定系統全片幅相機",
            quantity: 1,
            price: 79980,
            currency: "TWD",
            image_url: "https://s.yimg.com/wb/images/A176A536688C28AB6C6C1BC33BF931E0FDF4D3BD"
          }],
          address: {
            street_1: "三重路 66 號 14 樓",
            street_2: "",
            city: "台北市",
            postal_code: "94025",
            state: "台北市",
            country: "台灣"
          },
          summary: {
            "subtotal": 79980,
            "shipping_cost": 0,
            "total_tax": 0,
            "total_cost": 67183
          },
          adjustments: [{
            name: "全站 84 折",
            amount: -12797
          }]
        }
      }
    }
  };

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
 * Postback Event
 *
 * Ref: https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 */
function receivedPostback(event) {
  var senderID = event.sender.id;
  var recipientID = event.recipient.id;
  var timeOfPostback = event.timestamp;

  // 取得選單拋回來的內容
  var payload = event.postback.payload;
  console.log("Received postback for user %d and page %d with payload '%s' " + "at %d", senderID, recipientID, payload, timeOfPostback);

  if (payload === "View [型錄]") {
    sendGenericMessage(senderID);
  } else {
    sendTextMessage(senderID, "不知道怎麼處理的 Postback");
  }
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
