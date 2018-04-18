const randomstring = require('randomstring');
const _ = require('lodash');

const User = require('../../models/index').User;
const Upload = require('../../models/index').Upload;
const Comment = require('../../models/index').Comment;
const View = require('../../models/index').View;
const SiteVisit = require('../../models/index').SiteVisit;
const React = require('../../models/index').React;
const Notification = require('../../models/index').Notification;
const SocialPost = require('../../models/index').SocialPost;
const Subscription = require('../../models/index').Subscription;

const { uploadServer, uploadUrl } = require('../../lib/helpers/settings')

const thumbnailServer = process.env.THUMBNAIL_SERVER || '';

const pagination = require('../../lib/helpers/pagination');

const mongooseHelper = require('../../lib/caching/mongooseHelpers');


/**
 * GET /upload
 * Page to facilitate user uploads
 */
exports.getFileUpload = async (req, res) => {

  if(process.env.UPLOADS_DISABLED == 'true'){
    return res.render('api/disabledUploads', {
      title: 'File Upload'
    });
  }

  // give user an upload token
  if(!req.user.uploadToken){
    const uploadToken = randomstring.generate(25);
    req.user.uploadToken = uploadToken;
    await req.user.save();
  }

  res.render('upload', {
    title: 'File Upload',
    uploadUrl
  });
};

/**
 * GET /media/subscribed
 * Get user's individual subscriptions page
 */
exports.subscriptions = async (req, res) => {

  try {

    if (!req.user) {
      req.flash('errors', {msg: 'Please register to see your subscriptions'});

      return res.redirect('/signup')
    }

    req.user.unseenSubscriptionUploads = 0;
    await req.user.save();

    let page = req.params.page;
    if (!page) {
      page = 1
    }
    page = parseInt(page);

    const limit = 51;
    const skipAmount = (page * limit) - limit;

    const startingNumber = pagination.getMiddleNumber(page);
    const numbersArray = pagination.createArray(startingNumber);
    const previousNumber = pagination.getPreviousNumber(page);
    const nextNumber = pagination.getNextNumber(page);

    const subscriptions = await Subscription.find({subscribingUser: req.user._id, active: true});

    let subscribedToUsers = [];
    for (const subscription of subscriptions) {
      subscribedToUsers.push(subscription.subscribedToUser);
    }

    const uploads = await Upload.find({
      uploader: {$in: subscribedToUsers},
      visibility: 'public',
      $or : [ { status: 'completed' }, { uploadUrl: { $exists: true } } ]
    }).populate('uploader checkedViews')
      .skip((page * limit) - limit)
      .limit(limit).sort({createdAt: -1});

    res.render('account/subscriptions', {
      title: 'Subscriptions',
      uploads,
      numbersArray,
      highlightedNumber: page,
      previousNumber,
      nextNumber,
      uploadServer
    });

  } catch (err){
    console.log(err);
  }
};


/**
 * GET /channel
 * Profile page.
 */
exports.getChannel = async (req, res) => {

  let orderBy;
  if(!req.query.orderBy){
    orderBy = 'newToOld'
  } else {
    orderBy = req.query.orderBy;
  }

  if(orderBy !== 'popular' && orderBy !== 'newToOld' && orderBy !== 'oldToNew'){
    console.log('doesnt connect');
    orderBy = 'newToOld'
  }

  let user;
  try {

    // find the user per channelUrl
    user = await User.findOne({
      channelUrl : new RegExp(["^", req.params.channel, "$"].join(""), "i"),
      status: { $ne: 'restricted' }
    }).populate('receivedSubscriptions').lean().exec();

    // 404 if nothing found
    if(!user){
      res.status(404);
      return res.render('error/404', {
        title: 'Not Found'
      });
    }

    if(user.channelUrl !== req.params.channel){
      return res.redirect('/user/' + user.channelUrl)
    }

    const siteVisits = await SiteVisit.find({ user: user });

    let ips = [];
    for(const visit of siteVisits){
      ips.push(visit.ip);
    }

    // console.log(ips);

    // console.log(siteVisits);


    // determine if its the user of the channel
    let isAdmin = false;
    let isUser = false;
    if(req.user){
      // its the same user
      isUser =  ( req.user._id.toString() == user._id.toString()  );

      // the requesting user is an adming
      isAdmin = req.user.role == 'admin';
    }

    const searchQuery = {
      uploader: user._id,
      visibility: 'public',
      $or : [ { status: 'completed' }, { uploadUrl: { $exists: true } } ]
      // uploadUrl: {$exists: true }
      // status: 'completed'
    };

    let uploads = await Upload.find(searchQuery).populate('checkedViews').sort({ createdAt : -1 })

    // console.log(uploads.length);

    user.uploads = await mongooseHelper.determineLegitViewsForUploads(uploads);

    user.uploads = _.filter(user.uploads, function(upload){
      return upload.visibility == 'public'
    });

    // console.log(user.uploads.length);


    let totalViews = 0;
    for(upload of user.uploads){
      totalViews = totalViews + upload.legitViewAmount;
    }

    user.totalViews = totalViews;

    // remove unlisted videos if its not user and is not admin
    if(!isUser && !isAdmin){
      user.uploads = _.filter(user.uploads, function(upload){return upload.visibility == 'public'})
    }

    let uploadThumbnailUrl;
    if(user.uploads && user.uploads[0]){
      uploadThumbnailUrl =  user.uploads[0].thumbnailUrl;
    }

    res.locals.meta.image = user.thumbnailUrl || uploadThumbnailUrl;

    if(orderBy == 'popular'){
      user.uploads = user.uploads.sort(function(a, b) {
        return b.legitViewAmount - a.legitViewAmount;
      });
    }

    if(orderBy == 'newToOld'){

      console.log('new to old')
      user.uploads = user.uploads.sort(function(a, b) {
        return b.createdAt - a.createdAt;
      });
    }

    if(orderBy == 'oldToNew'){

      console.log('old to new')
      user.uploads = user.uploads.sort(function(a, b) {
        return a.createdAt - b.createdAt;
      });
    }

    // TODO: add pagination here

    let orderByEnglishString;

    if(orderBy == 'oldToNew'){
      orderByEnglishString = 'Old To New'
    }

    if(orderBy == 'newToOld'){
      orderByEnglishString = 'New To Old'
    }

    if(orderBy == 'popular'){
      orderByEnglishString = 'Popular'
    }

    let alreadySubbed = false;

    user.receivedSubscriptions = _.filter(user.receivedSubscriptions, function(subscription){
      return subscription.active == true;
    });

    // determine if user is subbed already
    if(req.user && user.receivedSubscriptions){
      for(let subscription of user.receivedSubscriptions){

        if(subscription.subscribingUser.toString() == req.user._id.toString()){
          alreadySubbed = true
        }
      }
    }



    let subscriberAmount;
    if(user.receivedSubscriptions){
      subscriberAmount = user.receivedSubscriptions.length;
    } else {
      subscriberAmount = 0;
    }

    res.locals.meta.title = `${user.channelName || user.channelUrl} - on PewTube`;

    if(user.channelDescription) res.locals.meta.description = user.channelDescription;

    if(user.thumbnailUrl){
      res.locals.meta.image = user.thumbnailUrl;
    }

    // TODO: Need to pull this into own library to work
    // if(user.uploads){
    //   res.locals.meta.image = user.uploads[0].customThumbnailUrl || ;
    // }

    let filter;
    if(req.user){
      filter = req.user.filter
    } else {
      filter = req.siteVisitor.filter
    }

    if(filter == 'sensitive'){
      // nothing to do
    } else if (filter == 'mature'){

      // return ones not marked as sensitive
      user.uploads = _.filter(user.uploads, function(upload){
        return upload.rating !== 'sensitive'
      });

    } else if (filter == 'allAges'){

      // return ones not marked as sensitive or mature
      user.uploads = _.filter(user.uploads, function(upload){
        return upload.rating !== 'sensitive' && upload.rating !== 'mature'
      });

    }



    const siteVisitor = req.siteVisitor;

    res.render('account/channel', {
      channel : user,
      title: user.channelName || user.channelUrl,
      isUser,
      isAdmin,
      orderByEnglishString,
      alreadySubbed,
      subscriberAmount,
      uploadServer,
      ips,
      siteVisitor
    });


  } catch (err){
    console.log(err);

    res.status(500);
    return res.render('error/500', {
      title: 'Server Error'
    });
  }

};

/**
 * GET /notifications
 * User's specific notifications page
 */
exports.notification = async (req, res) => {

  try {

    const notifications = await Notification.find({
      user: req.user._id
    }).populate('user sender upload react comment').sort({createdAt: -1});

    // // console.log(notifications);
    // for(let notif of notifications){
    //   console.log(notif);
    //   console.log(notif.sender);
    //   console.log(notif.sender.channelName)
    // }

    res.render('account/notifications', {
      title: 'Notifications',
      notifications
    });

    // mark notifs as read
    for (const notif of notifications) {
      if (notif.read == false) {

        notif.read = true;
        await notif.save();
      }
    }

  } catch (err){
    console.log(err);
    return res.render('error/500');
  }
};

/**
 * GET /subscriptionsByViews
 * Shows subscription uploads ordered by view amount
 */
exports.subscriptionsByViews = async (req, res) => {
  if(!req.user){
    req.flash('errors', { msg: 'Please login to see your subscriptions' });

    return res.redirect('/')
  }

  const subscriptions = await Subscription.find({ subscribingUser: req.user._id, active: true });

  let subscribedToUsers = [];
  for(const subscription of subscriptions){
    subscribedToUsers.push(subscription.subscribedToUser);
  }

  let uploads = await Upload.find({
    uploader: { $in: subscribedToUsers },
    visibility: 'public',
    uploadUrl: { $exists: true }
  }).populate('uploader checkedViews');

  uploads = _.orderBy(uploads, function(upload){
    return upload.checkedViews.length
  });


  res.render('account/subscriptionsByViews', {
    title: 'Subscriptions',
    uploads
  });
};


/**
 * GET /Edit upload channel
 * Profile page.
 */
exports.editUpload = async (req, res) => {

  // channel id and file name
  const channel = req.params.channel;
  const media = req.params.media;

  let upload = await Upload.findOne({
    uniqueTag: media,
    visibility: { $ne: 'removed' }
  }).populate({path: 'uploader comments checkedViews', populate: {path: 'commenter'}}).exec();

  console.log(upload.rating);

  // determine if its the user of the channel
  let isAdmin = false;
  let isUser = false;
  if(req.user){
    // its the same user
    isUser =  ( req.user._id.toString() == upload.uploader._id.toString()  );

    // the requesting user is an adming
    isAdmin = req.user.role == 'admin';
  }

  if(!isUser && !isAdmin){
    return res.render('error/403');
  }

  res.render('account/editUpload', {
    title: 'Edit Upload',
    upload,
    uploadServer,
    thumbnailServer,
    rating: upload.rating
  })


};


/**
 * GET /logout
 * Log out.
 */
exports.logout = (req, res) => {
  req.logout();
  res.redirect('/');
};

/**
 * GET /signup
 * Signup page.
 */
exports.getSignup = (req, res) => {

  const recaptchaPublicKey = process.env.RECAPTCHA_SITEKEY;

  if (req.user) {
    return res.redirect('/');
  }
  res.render('account/signup', {
    title: 'Create Account',
    recaptchaPublicKey
  });
};

/**
 * GET /account
 * Account page.
 */
exports.getAccount = async (req, res) => {
  const stripeToken = process.env.STRIPE_FRONTEND_TOKEN;

  // give user an upload token
  if(!req.user.uploadToken){
    const uploadToken = randomstring.generate(25);
    req.user.uploadToken = uploadToken;
    await req.user.save();
  }

  console.log(thumbnailServer)

  res.render('account/account', {
    title: 'Account Management',
    stripeToken,
    uploadServer,
    thumbnailServer
  });
};

/**
 * GET /account/reactHistory
 * React history page.
 */
exports.getReactHistory = async (req, res) => {
  const reacts = await React.find({
    user : req.user._id
  }).populate({path: 'upload', populate: {path: 'uploader'}}).sort({ createdAt: -1 });

  res.render('account/reactHistory', {
    title: 'React History',
    reacts
  });
};


/**
 * GET /account/viewHistory
 * View history page.
 */
exports.getViewHistory = async (req, res) => {

  const siteVisits = await SiteVisit.find({
    user: req.user._id
  }).select('_id');

  let ids = [];
  for(const id of siteVisits){
    ids.push(id.id);
  }

  const views = await View.find({
    validity: 'real',
    siteVisitor: { $in : ids }
  }).populate({path: 'upload', populate: {path: 'uploader'}}).sort({ createdAt: -1 });

  console.log(views.length);

  res.render('account/viewHistory', {
    title: 'View History',
    views
  });
};

/**
 * GET /reset/:token
 * Reset Password page.
 */
exports.getReset = (req, res, next) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  User
    .findOne({ passwordResetToken: req.params.token })
    .where('passwordResetExpires').gt(Date.now())
    .exec((err, user) => {
      if (err) { return next(err); }
      if (!user) {
        req.flash('errors', { msg: 'Password reset token is invalid or has expired.' });
        return res.redirect('/forgot');
      }
      res.render('account/reset', {
        title: 'Password Reset'
      });
    });
};


/**
 * GET /forgot
 * Forgot Password page.
 */
exports.getForgot = (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.render('account/forgot', {
    title: 'Forgot Password'
  });
};


/**
 * GET /account/unlink/:provider
 * Unlink OAuth provider.
 */
exports.getOauthUnlink = (req, res, next) => {
  const provider = req.params.provider;
  User.findById(req.user.id, (err, user) => {
    if (err) { return next(err); }
    user[provider] = undefined;
    user.tokens = user.tokens.filter(token => token.kind !== provider);
    user.save((err) => {
      if (err) { return next(err); }
      req.flash('info', { msg: `${provider} account has been unlinked.` });
      res.redirect('/account');
    });
  });
};


/**
 * GET /login
 * Login page.
 */
exports.getLogin = (req, res) => {
  if (req.user) {
    return res.redirect('/');
  }
  res.render('account/login', {
    title: 'Login'
  });
};

/**
 * GET /livestream
 * Livestream info page
 */
exports.livestreaming = async (req, res) => {
  res.render('livestream/livestreaming', {
    title: 'Livestreaming'
  });
};