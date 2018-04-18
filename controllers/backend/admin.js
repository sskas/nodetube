const fs = require('fs');
const _ = require('lodash');
const moment = require('moment');
const Promise = require('bluebird');
const randomstring = require('randomstring');
const mkdirp = Promise.promisifyAll(require('mkdirp'));
const ffmpegHelper = require('../../lib/uploading/ffmpeg');

const javascriptTimeAgo = require('javascript-time-ago');
javascriptTimeAgo.locale(require('javascript-time-ago/locales/en'));
require('javascript-time-ago/intl-messageformat-global');
require('intl-messageformat/dist/locale-data/en');
const timeAgoEnglish = new javascriptTimeAgo('en-US');

const User = require('../../models/index').User;
const Upload = require('../../models/index').Upload;
const Comment = require('../../models/index').Comment;
const View = require('../../models/index').View;
const SiteVisit = require('../../models/index').SiteVisit;
const React = require('../../models/index').React;
const Notification = require('../../models/index').Notification;
const SocialPost = require('../../models/index').SocialPost;
const Subscription = require('../../models/index').Subscription;

const gab = require('../../lib/socialMedia/gab');
const twitter = require('../../lib/socialMedia/twitter');
const facebook = require('../../lib/socialMedia/facebook');

const oneOffSocialPost = require('../../lib/socialMedia/oneOffSocialPost');

const mongoose = require('mongoose');

const redisClient = require('../../config/redis');


const deleteUsers = require('../../lib/administration/deleteUsers');


exports.postUsers = async (req, res) => {

  const userId = req.body.user;

  const userChangeValue = req.body.userChangeValue;

  // kick out if not admin or moderator
  const userRole = req.user.role;
  if(userRole !== 'admin'){
    res.status(404);
    return res.redirect('error/404', {
      title: 'Not Found'
    });
  }

  const user = await User.findOne({ _id: userId });

  if(userChangeValue == 'trustUser'){
    user.privs.autoVisibleUpload = true;
    await user.save();
  }

  if(userChangeValue == 'untrustUser'){
    user.privs.autoVisibleUpload = false;
    await user.save();
  }

  if(userChangeValue == 'banUser'){
    user.status = 'restricted';
    await user.save();
  }

  if(userChangeValue == 'unbanUser'){
    user.status = '';
    await user.save();
  }

  req.flash('success', {msg: `User ${user.channelName} moderated, thank you.`});

  res.redirect('/admin/users');

};






exports.deleteAllUsersAndBlockIps = async (req, res) => {

  console.log(req.body);

  try {

    const response = await deleteUsers.deleteAllUsersAndBlockIps(req.body.channelUrl);

    res.send(response);

  } catch (err){
    res.status(500);
    res.send('fail');
  }

  // let unlistedUploads = await Upload.find({ visibility: 'unlisted' });



};


exports.changeRatings = async (req, res) => {

  try {

    let rating = req.body.rating;
    let uploads = req.body.uploads;

    for (let upload of uploads) {
      let foundUpload = await Upload.findOne({_id: upload});
      foundUpload.rating = rating;
      foundUpload.moderated = true;
      await foundUpload.save();
    }

    res.send('success');

  } catch (err){
    res.status(500);
    res.send('fail');
  }

  // let unlistedUploads = await Upload.find({ visibility: 'unlisted' });



};




async function markUploadAsComplete(uniqueTag, channelUrl, user, res){
  upload = await Upload.findOne({ uniqueTag });
  upload.status = 'completed';
  await upload.save();

  user.uploads.push(upload._id);
  await user.save();

  return 'success'
}

async function updateUsersUnreadSubscriptions(user){
  const subscriptions = await Subscription.find({ subscribedToUser: user._id, active: true });

  for(const subscription of subscriptions){
    let subscribingUser = await User.findOne({ _id: subscription.subscribingUser });

    subscribingUser.unseenSubscriptionUploads = subscribingUser.unseenSubscriptionUploads + 1;
    await subscribingUser.save();
  }

};





exports.deleteAccount = async (req, res) => {

  let channelUrl = req.body.channelUrl;

  let user = await User.findOne({
    channelUrl
  });

  user.status = 'restricted';

  await user.save();

  const uploads = await Upload.find({ uploader: user._id });

  const comments = await Comment.find({ commenter: user._id });


  for(let upload of uploads){
    upload.visibility = 'removed';
    await upload.save();
  }

  for(let comment of comments){
    comment.visibility = 'removed';
    await comment.save();
  }

  res.send('success');

  // res.redirect(`/user/${channelUrl}`);
};



exports.deleteUpload = async (req, res) => {

  const upload = await Upload.findOne({ uniqueTag: req.body.videoId }).populate('uploader');

  const userOwnsUploads = req.user._id.toString() == upload.uploader._id.toString();

  const userIsAdmin = req.user.role == 'admin';

  if(userOwnsUploads || userIsAdmin){
    upload.visibility = 'removed';
    await upload.save();
    req.flash('success', {msg: `Upload successfully deleted`});
    res.redirect(`/user/${req.user.channelUrl}/`)
  } else {
    res.status(403);
    return res.render('error/500', {
      title: 'Server Error'
    });
  }
};


exports.postPending = async (req, res) => {

  const fromUploads = /uploads/.test(req.headers.referer)

  const uniqueTag = req.body.uniqueTag;
  const moderationValue = req.body.moderationValue;

  console.log(uniqueTag, moderationValue);

  const upload = await Upload.findOne({ uniqueTag }).populate('uploader');
  const user = await User.findOne({ _id : upload.uploader });

  if(moderationValue == 'approve'){
    upload.visibility = 'public';
    await upload.save();
  }

  if(moderationValue == 'approveAndTrustUser'){
    upload.visibility = 'public';
    await upload.save();

    user.privs.autoVisibleUpload = true;
    await user.save();
  }

  if(moderationValue == 'banVideo'){
    upload.visibility = 'removed';
    await upload.save();
  }

  if(moderationValue== 'banVideoAndUser'){
    upload.visibility = 'removed';
    await upload.save();

    user.status = 'restricted';
    await user.save();
  }

  req.flash('success', {msg: `${upload.title} by ${user.channelName} moderated, thank you.`});

  if(fromUploads){
    res.redirect('/admin/uploads')
  } else {
    res.redirect('/pending');
  }

};





exports.postSiteVisitors = async (req, res) => {

  res.send('hello');

};

exports.postComments = async (req, res) => {

  const userId = req.body.user;
  const commentId = req.body.comment;
  const commentChangeValue = req.body.commentChangeValue;

  const user = await User.findOne({ _id: userId });
  const comment = await Comment.findOne({ _id: commentId });

  if(commentChangeValue == 'deleteComment'){
    comment.visibility = 'removed';
    await comment.save();
  }

  if(commentChangeValue == 'reinstateComment'){
    comment.visibility = 'public';
    await comment.save();
  }

  if(commentChangeValue == 'deleteCommentBanUser'){
    comment.visibility = 'removed';
    await comment.save();
    user.status = 'restricted';
    await user.save();
  }

  req.flash('success', {msg: `Comment by ${user.channelName} moderated, thank you.`});

  res.redirect('/admin/comments');
};




exports.sendNotification = async (req, res) => {

  let message = req.body.message;
  let channelUrl = req.body.channelUrl;

  const user = await User.findOne({
    channelUrl
  });


  let notification = new Notification({
    user,
    sender: req.user,
    action: 'message',
    text: message
  });

  await notification.save();

  res.redirect('/admin/notifications');
};



exports.postUsers = async (req, res) => {

  const userId = req.body.user;

  const userChangeValue = req.body.userChangeValue;

  const user = await User.findOne({ _id: userId });

  if(userChangeValue == 'trustUser'){
    user.privs.autoVisibleUpload = true;
    await user.save();
  }

  if(userChangeValue == 'untrustUser'){
    user.privs.autoVisibleUpload = false;
    await user.save();
  }

  if(userChangeValue == 'banUser'){
    user.status = 'restricted';
    await user.save();
  }

  if(userChangeValue == 'unbanUser'){
    user.status = '';
    await user.save();
  }

  req.flash('success', {msg: `User ${user.channelName} moderated, thank you.`});

  res.redirect('/admin/users');

};


exports.getUserAccounts = async (req, res) => {

  try {

    const response = await deleteUsers.getUsersAndSiteVisitAmount(req.body.channelUrl);

    res.send(response);

  } catch (err){
    res.status(500);
    res.send('fail');
  }

  // let unlistedUploads = await Upload.find({ visibility: 'unlisted' });



};