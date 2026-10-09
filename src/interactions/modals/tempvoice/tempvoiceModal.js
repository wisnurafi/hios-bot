// tempvoiceModal.js — modal dispatcher for TempVoice interface forms.
//
// Modals use customIds like `tempvoice_modal:rename`; interactionCreate splits
// on ':' and routes here with args = ['rename'].

import { dispatchTempVoiceModal } from '../../../services/tempvoiceInterface.js';

export default {
    name: 'tempvoice_modal',
    async execute(interaction, client, args) {
        const action = args?.[0];
        await dispatchTempVoiceModal(interaction, client, action);
    },
};
