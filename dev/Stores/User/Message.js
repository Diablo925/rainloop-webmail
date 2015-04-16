
(function () {

	'use strict';

	var
		_ = require('_'),
		ko = require('ko'),
		window = require('window'),
		$ = require('$'),

		kn = require('Knoin/Knoin'),

		Enums = require('Common/Enums'),
		Consts = require('Common/Consts'),
		Globals = require('Common/Globals'),
		Utils = require('Common/Utils'),
		Links = require('Common/Links'),
		Translator = require('Common/Translator'),

		Cache = require('Common/Cache'),

		AppStore = require('Stores/User/App'),
		FolderStore = require('Stores/User/Folder'),
		SettingsStore = require('Stores/User/Settings'),

		Remote = require('Remote/User/Ajax'),

		MessageModel = require('Model/Message'),
		MessageHelper = require('Helper/Message')
	;

	/**
	 * @constructor
	 */
	function MessageUserStore()
	{
		this.staticMessage = new MessageModel();

		this.messageList = ko.observableArray([]).extend({'rateLimit': 0});

		this.messageListCount = ko.observable(0);
		this.messageListSearch = ko.observable('');
		this.messageListPage = ko.observable(1);
		this.messageListError = ko.observable('');

		this.messageListEndFolder = ko.observable('');
		this.messageListEndSearch = ko.observable('');
		this.messageListEndPage = ko.observable(1);

		this.messageListLoading = ko.observable(false);
		this.messageListIsNotCompleted = ko.observable(false);
		this.messageListCompleteLoadingThrottle = ko.observable(false).extend({'throttle': 200});
		this.messageListCompleteLoadingThrottleForAnimation = ko.observable(false).extend({'specialThrottle': 700});

		this.messageListDisableAutoSelect = ko.observable(false).extend({'falseTimeout': 500});

		this.selectorMessageSelected = ko.observable(null);
		this.selectorMessageFocused = ko.observable(null);

		// message viewer
		this.message = ko.observable(null);

		this.message.viewTrigger = ko.observable(false);

		this.messageThreadList = ko.observableArray([]);

		this.messageLastThreadUidsData = ko.observable(null);

		this.messageError = ko.observable('');

		this.messageCurrentLoading = ko.observable(false);
		this.messageThreadLoading = ko.observable(false);

		this.messageLoading = ko.computed(function () {
			return !!(this.messageCurrentLoading() || this.messageThreadLoading());
		}, this);

		this.messageLoadingThrottle = ko.observable(false).extend({'throttle': 50});

		this.messageFullScreenMode = ko.observable(false);

		this.messagesBodiesDom = ko.observable(null);
		this.messageActiveDom = ko.observable(null);

		this.computers();
		this.subscribers();

		this.onMessageResponse = _.bind(this.onMessageResponse, this);

		this.purgeMessageBodyCacheThrottle = _.throttle(this.purgeMessageBodyCache, 1000 * 30);
	}

	MessageUserStore.prototype.computers = function ()
	{
		this.messageListEndHash = ko.computed(function () {
			return this.messageListEndFolder() + '|' + this.messageListEndSearch() + '|' + this.messageListEndPage();
		}, this);

		this.messageListPageCount = ko.computed(function () {
			var iPage = window.Math.ceil(this.messageListCount() /
				SettingsStore.messagesPerPage());
			return 0 >= iPage ? 1 : iPage;
		}, this);

		this.mainMessageListSearch = ko.computed({
			'read': this.messageListSearch,
			'write': function (sValue) {
				kn.setHash(Links.mailBox(
					FolderStore.currentFolderFullNameHash(), 1, Utils.trim(sValue.toString())
				));
			},
			'owner': this
		});

		this.messageListCompleteLoading = ko.computed(function () {
			var
				bOne = this.messageListLoading(),
				bTwo = this.messageListIsNotCompleted()
			;
			return bOne || bTwo;
		}, this);

		this.isMessageSelected = ko.computed(function () {
			return null !== this.message();
		}, this);

		this.messageListChecked = ko.computed(function () {
			return _.filter(this.messageList(), function (oItem) {
				return oItem.checked();
			});
		}, this).extend({'rateLimit': 0});

		this.hasCheckedMessages = ko.computed(function () {
			return 0 < this.messageListChecked().length;
		}, this).extend({'rateLimit': 0});

		this.messageListCheckedOrSelected = ko.computed(function () {

			var
				aChecked = this.messageListChecked(),
				oSelectedMessage = this.selectorMessageSelected()
			;

			return _.union(aChecked, oSelectedMessage ? [oSelectedMessage] : []);

		}, this);

		this.messageListCheckedOrSelectedUidsWithSubMails = ko.computed(function () {
			var aList = [];
			_.each(this.messageListCheckedOrSelected(), function (oMessage) {
				if (oMessage)
				{
					aList.push(oMessage.uid);
					if (1 < oMessage.threadsLen())
					{
						aList = _.union(aList, oMessage.threads());
					}
				}
			});
			return aList;
		}, this);
	};

	MessageUserStore.prototype.subscribers = function ()
	{
		this.messageListCompleteLoading.subscribe(function (bValue) {
			bValue = !!bValue;
			this.messageListCompleteLoadingThrottle(bValue);
			this.messageListCompleteLoadingThrottleForAnimation(bValue);
		}, this);

		this.messageList.subscribe(_.debounce(function (aList) {
			_.each(aList, function (oItem) {
				if (oItem && oItem.newForAnimation())
				{
					oItem.newForAnimation(false);
				}
			});
		}, 500));

		this.message.subscribe(function (oMessage) {

			if (oMessage)
			{
				 if (Enums.Layout.NoPreview === SettingsStore.layout())
				{
					AppStore.focusedState(Enums.Focused.MessageView);
				}
			}
			else
			{
				AppStore.focusedState(Enums.Focused.MessageList);

				this.messageFullScreenMode(false);
				this.hideMessageBodies();
			}

		}, this);

		this.messageLoading.subscribe(function (bValue) {
			this.messageLoadingThrottle(bValue);
		}, this);

		this.messagesBodiesDom.subscribe(function (oDom) {
			if (oDom && !(oDom instanceof $))
			{
				this.messagesBodiesDom($(oDom));
			}
		}, this);

		this.messageListEndFolder.subscribe(function (sFolder) {
			var oMessage = this.message();
			if (oMessage && sFolder && sFolder !== oMessage.folderFullNameRaw)
			{
				this.message(null);
			}
		}, this);
	};

	MessageUserStore.prototype.purgeMessageBodyCache = function()
	{
		var
			iCount = 0,
			oMessagesBodiesDom = null,
			iEnd = Globals.iMessageBodyCacheCount - Consts.Values.MessageBodyCacheLimit
		;

		if (0 < iEnd)
		{
			oMessagesBodiesDom = this.messagesBodiesDom();
			if (oMessagesBodiesDom)
			{
				oMessagesBodiesDom.find('.rl-cache-class').each(function () {
					var oItem = $(this);
					if (iEnd > oItem.data('rl-cache-count'))
					{
						oItem.addClass('rl-cache-purge');
						iCount++;
					}
				});

				if (0 < iCount)
				{
					_.delay(function () {
						oMessagesBodiesDom.find('.rl-cache-purge').remove();
					}, 300);
				}
			}
		}
	};

	MessageUserStore.prototype.initUidNextAndNewMessages = function (sFolder, sUidNext, aNewMessages)
	{
		if (Cache.getFolderInboxName() === sFolder && Utils.isNormal(sUidNext) && sUidNext !== '')
		{
			if (Utils.isArray(aNewMessages) && 0 < aNewMessages.length)
			{
				var
					iIndex = 0,
					iLen = aNewMessages.length,
					NotificationStore = require('Stores/User/Notification')
				;

				_.each(aNewMessages, function (oItem) {
					Cache.addNewMessageCache(sFolder, oItem.Uid);
				});

				NotificationStore.playSoundNotification();

				if (3 < iLen)
				{
					NotificationStore.displayDesktopNotification(
						Links.notificationMailIcon(),
						require('Stores/User/Account').email(),
						Translator.i18n('MESSAGE_LIST/NEW_MESSAGE_NOTIFICATION', {
							'COUNT': iLen
						})
					);
				}
				else
				{
					for (; iIndex < iLen; iIndex++)
					{
						NotificationStore.displayDesktopNotification(
							Links.notificationMailIcon(),
							MessageHelper.emailArrayToString(
								MessageHelper.emailArrayFromJson(aNewMessages[iIndex].From), false),
							aNewMessages[iIndex].Subject
						);
					}
				}
			}

			Cache.setFolderUidNext(sFolder, sUidNext);
		}
	};

	MessageUserStore.prototype.hideMessageBodies = function ()
	{
		var oMessagesBodiesDom = this.messagesBodiesDom();
		if (oMessagesBodiesDom)
		{
			oMessagesBodiesDom.find('.b-text-part').hide();
		}
	};

	/**
	 * @param {string} sFromFolderFullNameRaw
	 * @param {Array} aUidForRemove
	 * @param {string=} sToFolderFullNameRaw = ''
	 * @param {bCopy=} bCopy = false
	 */
	MessageUserStore.prototype.removeMessagesFromList = function (
		sFromFolderFullNameRaw, aUidForRemove, sToFolderFullNameRaw, bCopy)
	{
		sToFolderFullNameRaw = Utils.isNormal(sToFolderFullNameRaw) ? sToFolderFullNameRaw : '';
		bCopy = Utils.isUnd(bCopy) ? false : !!bCopy;

		aUidForRemove = _.map(aUidForRemove, function (mValue) {
			return Utils.pInt(mValue);
		});

		var
			self = this,
			iUnseenCount = 0,
			aMessageList = this.messageList(),
			oFromFolder = Cache.getFolderFromCacheList(sFromFolderFullNameRaw),
			oToFolder = '' === sToFolderFullNameRaw ? null : Cache.getFolderFromCacheList(sToFolderFullNameRaw || ''),
			sCurrentFolderFullNameRaw = FolderStore.currentFolderFullNameRaw(),
			oCurrentMessage = this.message(),
			aMessages = sCurrentFolderFullNameRaw === sFromFolderFullNameRaw ? _.filter(aMessageList, function (oMessage) {
				return oMessage && -1 < Utils.inArray(Utils.pInt(oMessage.uid), aUidForRemove);
			}) : []
		;

		_.each(aMessages, function (oMessage) {
			if (oMessage && oMessage.unseen())
			{
				iUnseenCount++;
			}
		});

		if (oFromFolder && !bCopy)
		{
			oFromFolder.messageCountAll(0 <= oFromFolder.messageCountAll() - aUidForRemove.length ?
				oFromFolder.messageCountAll() - aUidForRemove.length : 0);

			if (0 < iUnseenCount)
			{
				oFromFolder.messageCountUnread(0 <= oFromFolder.messageCountUnread() - iUnseenCount ?
					oFromFolder.messageCountUnread() - iUnseenCount : 0);
			}
		}

		if (oToFolder)
		{
			oToFolder.messageCountAll(oToFolder.messageCountAll() + aUidForRemove.length);
			if (0 < iUnseenCount)
			{
				oToFolder.messageCountUnread(oToFolder.messageCountUnread() + iUnseenCount);
			}

			oToFolder.actionBlink(true);
		}

		if (0 < aMessages.length)
		{
			if (bCopy)
			{
				_.each(aMessages, function (oMessage) {
					oMessage.checked(false);
				});
			}
			else
			{
				this.messageListIsNotCompleted(true);

				_.each(aMessages, function (oMessage) {
					if (oCurrentMessage && oCurrentMessage.hash === oMessage.hash)
					{
						oCurrentMessage = null;
						self.message(null);
					}

					oMessage.deleted(true);
				});

				_.delay(function () {
					_.each(aMessages, function (oMessage) {
						self.messageList.remove(oMessage);
					});
				}, 400);
			}
		}

		if ('' !== sFromFolderFullNameRaw)
		{
			Cache.setFolderHash(sFromFolderFullNameRaw, '');
		}

		if ('' !== sToFolderFullNameRaw)
		{
			Cache.setFolderHash(sToFolderFullNameRaw, '');
		}
	};

	MessageUserStore.prototype.addBlockquoteSwitcherCallback = function ()
	{
		var $self = $(this);
		if ('' !== Utils.trim(($self.text())))
		{
			$self.addClass('rl-bq-switcher hidden-bq');
			$('<span class="rlBlockquoteSwitcher"><i class="icon-ellipsis" /></span>')
				.insertBefore($self)
				.on('click.rlBlockquoteSwitcher', function () {
					$self.toggleClass('hidden-bq');
					Utils.windowResize();
				})
				.after('<br />')
				.before('<br />')
			;
		}
	};

	/**
	 * @param {Object} oMessageTextBody
	 */
	MessageUserStore.prototype.initBlockquoteSwitcher = function (oMessageTextBody)
	{
		if (oMessageTextBody)
		{
			var $oList = $('blockquote:not(.rl-bq-switcher)', oMessageTextBody).filter(function () {
				return 0 === $(this).parent().closest('blockquote', oMessageTextBody).length;
			});

			if ($oList && 0 < $oList.length)
			{
				$oList.each(this.addBlockquoteSwitcherCallback);
			}
		}
	};

	MessageUserStore.prototype.setMessage = function (oData, bCached)
	{
		var
			bNew = false,
			bIsHtml = false,
			bHasExternals = false,
			bHasInternals = false,
			oBody = null,
			oTextBody = null,
			sId = '',
			sResultHtml = '',
			bPgpSigned = false,
			bPgpEncrypted = false,
			oMessagesBodiesDom = this.messagesBodiesDom(),
			oSelectedMessage = this.selectorMessageSelected(),
			oMessage = this.message(),
			aThreads = []
		;

		if (oData && oMessage && oData.Result && 'Object/Message' === oData.Result['@Object'] &&
			oMessage.folderFullNameRaw === oData.Result.Folder)
		{
			aThreads = oMessage.threads();
			if (oMessage.uid !== oData.Result.Uid && 1 < aThreads.length &&
				-1 < Utils.inArray(oData.Result.Uid, aThreads))
			{
				oMessage = MessageModel.newInstanceFromJson(oData.Result);
				if (oMessage)
				{
					oMessage.threads(aThreads);
					Cache.initMessageFlagsFromCache(oMessage);

					this.message(this.staticMessage.populateByMessageListItem(oMessage));
					oMessage = this.message();

					bNew = true;
				}
			}

			if (oMessage && oMessage.uid === oData.Result.Uid)
			{
				this.messageError('');

				oMessage.initUpdateByMessageJson(oData.Result);
				Cache.addRequestedMessage(oMessage.folderFullNameRaw, oMessage.uid);

				if (!bCached)
				{
					oMessage.initFlagsByJson(oData.Result);
				}

				oMessagesBodiesDom = oMessagesBodiesDom && oMessagesBodiesDom[0] ? oMessagesBodiesDom : null;
				if (oMessagesBodiesDom)
				{
					sId = 'rl-mgs-' + oMessage.hash.replace(/[^a-zA-Z0-9]/g, '');
					oTextBody = oMessagesBodiesDom.find('#' + sId);
					if (!oTextBody || !oTextBody[0])
					{
						bHasExternals = !!oData.Result.HasExternals;
						bHasInternals = !!oData.Result.HasInternals;

						oBody = $('<div id="' + sId + '" />').hide().addClass('rl-cache-class');
						oBody.data('rl-cache-count', ++Globals.iMessageBodyCacheCount);

						if (Utils.isNormal(oData.Result.Html) && '' !== oData.Result.Html)
						{
							bIsHtml = true;
							sResultHtml = oData.Result.Html.toString();
						}
						else if (Utils.isNormal(oData.Result.Plain) && '' !== oData.Result.Plain)
						{
							bIsHtml = false;
							sResultHtml = Utils.plainToHtml(oData.Result.Plain.toString(), false);

							if ((oMessage.isPgpSigned() || oMessage.isPgpEncrypted()) && require('Stores/User/Pgp').capaOpenPGP())
							{
								oMessage.plainRaw = Utils.pString(oData.Result.Plain);

								bPgpEncrypted = /---BEGIN PGP MESSAGE---/.test(oMessage.plainRaw);
								if (!bPgpEncrypted)
								{
									bPgpSigned = /-----BEGIN PGP SIGNED MESSAGE-----/.test(oMessage.plainRaw) &&
										/-----BEGIN PGP SIGNATURE-----/.test(oMessage.plainRaw);
								}

								Globals.$div.empty();
								if (bPgpSigned && oMessage.isPgpSigned())
								{
									sResultHtml =
										Globals.$div.append(
											$('<pre class="b-plain-openpgp signed"></pre>').text(oMessage.plainRaw)
										).html()
									;
								}
								else if (bPgpEncrypted && oMessage.isPgpEncrypted())
								{
									sResultHtml =
										Globals.$div.append(
											$('<pre class="b-plain-openpgp encrypted"></pre>').text(oMessage.plainRaw)
										).html()
									;
								}

								Globals.$div.empty();

								oMessage.isPgpSigned(bPgpSigned);
								oMessage.isPgpEncrypted(bPgpEncrypted);
							}
						}
						else
						{
							bIsHtml = false;
						}

						oBody
							.html(Utils.findEmailAndLinks(sResultHtml))
							.addClass('b-text-part ' + (bIsHtml ? 'html' : 'plain'))
						;

						oMessage.isHtml(!!bIsHtml);
						oMessage.hasImages(!!bHasExternals);
						oMessage.pgpSignedVerifyStatus(Enums.SignedVerifyStatus.None);
						oMessage.pgpSignedVerifyUser('');

						oMessage.body = oBody;
						if (oMessage.body)
						{
							oMessagesBodiesDom.append(oMessage.body);
						}

						oMessage.storeDataToDom();

						if (bHasInternals)
						{
							oMessage.showInternalImages(true);
						}

						if (oMessage.hasImages() && SettingsStore.showImages())
						{
							oMessage.showExternalImages(true);
						}

						this.purgeMessageBodyCacheThrottle();
					}
					else
					{
						oMessage.body = oTextBody;
						if (oMessage.body)
						{
							oMessage.body.data('rl-cache-count', ++Globals.iMessageBodyCacheCount);
							oMessage.fetchDataToDom();
						}
					}

					this.messageActiveDom(oMessage.body);

					this.hideMessageBodies();

					if (oBody)
					{
						this.initBlockquoteSwitcher(oBody);
					}

					oMessage.body.show();
				}

				Cache.initMessageFlagsFromCache(oMessage);
				if (oMessage.unseen() || oMessage.hasUnseenSubMessage())
				{
					require('App/User').messageListAction(oMessage.folderFullNameRaw,
						oMessage.uid, Enums.MessageSetAction.SetSeen, [oMessage]);
				}

				if (bNew)
				{
					oMessage = this.message();

					if (oSelectedMessage && oMessage && (
						oMessage.folderFullNameRaw !== oSelectedMessage.folderFullNameRaw ||
						oMessage.uid !== oSelectedMessage.uid
					))
					{
						this.selectorMessageSelected(null);
						if (1 === this.messageList().length)
						{
							this.selectorMessageFocused(null);
						}
					}
					else if (!oSelectedMessage && oMessage)
					{
						oSelectedMessage = _.find(this.messageList(), function (oSubMessage) {
							return oSubMessage &&
								oSubMessage.folderFullNameRaw === oMessage.folderFullNameRaw &&
								oSubMessage.uid === oMessage.uid;
						});

						if (oSelectedMessage)
						{
							this.selectorMessageSelected(oSelectedMessage);
							this.selectorMessageFocused(oSelectedMessage);
						}
					}

				}

				Utils.windowResize();
			}
		}
	};

	MessageUserStore.prototype.selectMessage = function (oMessage)
	{
		if (oMessage)
		{
			this.message(this.staticMessage.populateByMessageListItem(oMessage));

			this.populateMessageBody(this.message());
		}
		else
		{
			this.message(null);
		}
	};

	MessageUserStore.prototype.selectThreadMessage = function (sFolder, sUid)
	{
		if (Remote.message(this.onMessageResponse, sFolder, sUid))
		{
			this.messageThreadLoading(true);
		}
	};

	MessageUserStore.prototype.populateMessageBody = function (oMessage)
	{
		if (oMessage)
		{
			if (Remote.message(this.onMessageResponse, oMessage.folderFullNameRaw, oMessage.uid))
			{
				this.messageCurrentLoading(true);
			}
		}
	};

	/**
	 * @param {string} sResult
	 * @param {AjaxJsonDefaultResponse} oData
	 * @param {boolean} bCached
	 */
	MessageUserStore.prototype.onMessageResponse = function (sResult, oData, bCached)
	{
		this.hideMessageBodies();

		this.messageCurrentLoading(false);
		this.messageThreadLoading(false);

		if (Enums.StorageResultType.Success === sResult && oData && oData.Result)
		{
			this.setMessage(oData, bCached);
		}
		else if (Enums.StorageResultType.Unload === sResult)
		{
			this.message(null);
			this.messageError('');
		}
		else if (Enums.StorageResultType.Abort !== sResult)
		{
			this.message(null);
			this.messageError((oData && oData.ErrorCode ?
				Translator.getNotification(oData.ErrorCode) :
				Translator.getNotification(Enums.Notification.UnknownError)));
		}
	};

	/**
	 * @param {Array} aList
	 * @return {string}
	 */
	MessageUserStore.prototype.calculateMessageListHash = function (aList)
	{
		return _.map(aList, function (oMessage) {
			return '' + oMessage.hash + '_' + oMessage.threadsLen() + '_' + oMessage.flagHash();
		}).join('|');
	};

	MessageUserStore.prototype.setMessageList = function (oData, bCached)
	{
		if (oData && oData.Result && 'Collection/MessageCollection' === oData.Result['@Object'] &&
			oData.Result['@Collection'] && Utils.isArray(oData.Result['@Collection']))
		{
			var
				self = this,
				iIndex = 0,
				iLen = 0,
				iCount = 0,
				iOffset = 0,
				aList = [],
				oJsonMessage = null,
				oMessage = null,
				oFolder = null,
				iNewCount = 0,
				iUtc = require('Common/Momentor').momentNowUnix(),
				bUnreadCountChange = false
			;

			iCount = Utils.pInt(oData.Result.MessageResultCount);
			iOffset = Utils.pInt(oData.Result.Offset);

			oFolder = Cache.getFolderFromCacheList(
				Utils.isNormal(oData.Result.Folder) ? oData.Result.Folder : '');

			if (oFolder && !bCached)
			{
				oFolder.interval = iUtc;

				Cache.setFolderHash(oData.Result.Folder, oData.Result.FolderHash);

				if (Utils.isNormal(oData.Result.MessageCount))
				{
					oFolder.messageCountAll(oData.Result.MessageCount);
				}

				if (Utils.isNormal(oData.Result.MessageUnseenCount))
				{
					if (Utils.pInt(oFolder.messageCountUnread()) !== Utils.pInt(oData.Result.MessageUnseenCount))
					{
						bUnreadCountChange = true;
					}

					oFolder.messageCountUnread(oData.Result.MessageUnseenCount);
				}

				this.initUidNextAndNewMessages(oFolder.fullNameRaw, oData.Result.UidNext, oData.Result.NewMessages);
			}

			if (bUnreadCountChange && oFolder)
			{
				Cache.clearMessageFlagsFromCacheByFolder(oFolder.fullNameRaw);
			}

			for (iIndex = 0, iLen = oData.Result['@Collection'].length; iIndex < iLen; iIndex++)
			{
				oJsonMessage = oData.Result['@Collection'][iIndex];
				if (oJsonMessage && 'Object/Message' === oJsonMessage['@Object'])
				{
					oMessage = MessageModel.newInstanceFromJson(oJsonMessage);
					if (oMessage)
					{
						if (Cache.hasNewMessageAndRemoveFromCache(oMessage.folderFullNameRaw, oMessage.uid) && 5 >= iNewCount)
						{
							iNewCount++;
							oMessage.newForAnimation(true);
						}

						oMessage.deleted(false);

						if (bCached)
						{
							Cache.initMessageFlagsFromCache(oMessage);
						}
						else
						{
							Cache.storeMessageFlagsToCache(oMessage);
						}

						aList.push(oMessage);
					}
				}
			}

			this.messageListCount(iCount);
			this.messageListSearch(Utils.isNormal(oData.Result.Search) ? oData.Result.Search : '');
			this.messageListPage(window.Math.ceil((iOffset / SettingsStore.messagesPerPage()) + 1));

			this.messageListEndFolder(Utils.isNormal(oData.Result.Folder) ? oData.Result.Folder : '');
			this.messageListEndSearch(Utils.isNormal(oData.Result.Search) ? oData.Result.Search : '');
			this.messageListEndPage(this.messageListPage());

			this.messageListDisableAutoSelect(true);

			this.messageList(aList);
			this.messageListIsNotCompleted(false);

			Cache.clearNewMessageCache();

			if (AppStore.threadsAllowed() && SettingsStore.useThreads())
			{
				oMessage = this.message();
				if (oMessage)
				{
					Remote.messageThreadsFromCache(function (sResult, oData) {

						if (Enums.StorageResultType.Success === sResult && oData &&  oData.Result && oData.Result.ThreadUids)
						{
							self.messageLastThreadUidsData({
								'Folder': oData.Result.Folder,
								'Uid': oData.Result.Uid,
								'Uids': oData.Result.ThreadUids
							});
						}

					}, oMessage.folderFullNameRaw, oMessage.uid);
				}
			}

			if (oFolder && (bCached || bUnreadCountChange || SettingsStore.useThreads()))
			{
				require('App/User').folderInformation(oFolder.fullNameRaw, aList);
			}
		}
		else
		{
			this.messageListCount(0);
			this.messageList([]);
			this.messageListError(Translator.getNotification(
				oData && oData.ErrorCode ? oData.ErrorCode : Enums.Notification.CantGetMessageList
			));
		}
	};

	module.exports = new MessageUserStore();

}());

