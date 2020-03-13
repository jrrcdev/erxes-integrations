import { debugWhatsapp } from '../debuggers';
import { sendRPCMessage } from '../messageBroker';
import { Integrations } from '../models';
import { ConversationMessages, Conversations, Customers } from './models';
export interface IUser {
  id: string;
  created_timestamp: string;
  name: string;
  screen_name: string;
  profile_image_url: string;
  profile_image_url_https: string;
}

export const getOrCreateCustomer = async (phoneNumber: string, name: string, instanceId: string) => {
  const integration = await Integrations.getIntegration({
    $and: [{ whatsappinstanceId: instanceId }, { kind: 'whatsapp' }],
  });

  let customer = await Customers.findOne({ phoneNumber });
  if (customer) {
    return customer;
  }

  customer = await Customers.create({
    phoneNumber,
    name,
    integrationId: integration.id,
  });

  // save on api
  try {
    const apiCustomerResponse = await sendRPCMessage({
      action: 'get-create-update-customer',
      payload: JSON.stringify({
        integrationId: integration.erxesApiId,
        firstName: name,
        phones: [phoneNumber],
        primaryPhone: phoneNumber,
        isUser: true,
      }),
    });
    customer.erxesApiId = apiCustomerResponse._id;
    await customer.save();
  } catch (e) {
    await Customers.deleteOne({ _id: customer._id });
    throw e;
  }

  return customer;
};

export const createOrUpdateConversation = async (messages, instanceId: string, customerIds, integrationIds) => {
  const { customerId, customerErxesApiID } = customerIds;
  const { integrationId, integrationErxesApiId } = integrationIds;
  let conversation = await Conversations.findOne({
    senderId: customerId,
    instanceId,
  });

  for (const message of messages || []) {
    if (!message || message.fromMe) {
      return true;
    }
    let conversationIds = {};
    if (conversation) {
      conversationIds = {
        conversationId: conversation.id,
        conversationErxesApiId: conversation.erxesApiId,
        customerErxesApiId: customerErxesApiID,
      };
      await createMessage(message, conversationIds);
      return conversation;
    }

    conversation = await Conversations.create({
      timestamp: new Date(),
      senderId: customerId,
      recipientId: message.chatId,
      content: message.body,
      integrationId,
      instanceId,
    });

    // save on api
    try {
      const apiConversationResponse = await sendRPCMessage({
        action: 'create-or-update-conversation',
        payload: JSON.stringify({
          customerId: customerErxesApiID,
          integrationId: integrationErxesApiId,
          content: message.body,
        }),
      });
      conversation.erxesApiId = apiConversationResponse._id;
      await conversation.save();
    } catch (e) {
      await Conversations.deleteOne({ _id: conversation._id });
      debugWhatsapp(`Error ocurred while trying to create or update conversation ${e.message}`);
      throw e;
    }
    conversationIds = {
      conversationId: conversation.id,
      conversationErxesApiId: conversation.erxesApiId,
      customerErxesApiId: customerErxesApiID,
    };
    await createMessage(message, conversationIds);
  }

  return conversation;
};

const createMessage = async (message, conversationIds) => {
  const { conversationId, conversationErxesApiId, customerErxesApiId } = conversationIds;
  const conversationMessage = await ConversationMessages.findOne({
    mid: message.id,
  });
  if (conversationMessage) {
    return conversationMessage;
  }

  await ConversationMessages.create({
    conversationId,
    mid: message.id,
    timestamp: new Date(),
    content: message.body,
  });
  let attachments = [];
  if (message.type !== 'chat') {
    const attachment = { type: message.type, url: message.body };
    attachments = [attachment];
    message.body = '';
  }

  if (message.caption) {
    message.body = message.caption;
  }
  if (message.quotedMsgBody) {
    message.body = message.quotedMsgBody;
  }
  try {
    await sendRPCMessage({
      action: 'create-conversation-message',
      metaInfo: 'replaceContent',
      payload: JSON.stringify({
        content: message.body,
        attachments: (attachments || []).map(att => ({
          type: att.type,
          url: att.url,
        })),
        conversationId: conversationErxesApiId,
        customerId: customerErxesApiId,
      }),
    });
  } catch (e) {
    await ConversationMessages.deleteOne({ mid: message.mid });
    throw new Error(e);
  }
  return conversationMessage;
};
