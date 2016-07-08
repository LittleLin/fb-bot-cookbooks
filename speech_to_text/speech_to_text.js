var fs = require('fs');
var watson = require('watson-developer-cloud');

/*
 * 請註冊 & 填入 IBM watson username/password 如下
 */
var speech_to_text = watson.speech_to_text({
    username: "",
    password: "",
    version: 'v1'
});
var watson_params = {
    audio: fs.createReadStream('./material/output.wav'),
    model: 'zh-CN_NarrowbandModel',
    content_type: 'audio/wav'
};

speech_to_text.recognize(watson_params, function(err, res) {
  if (err)
    console.log(err);
  else
    console.log(JSON.stringify(res, null, 2));
});
