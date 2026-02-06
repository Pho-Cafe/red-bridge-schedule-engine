import admin from 'firebase-admin';
import * as dotenv from 'dotenv';

dotenv.config();

import * as serviceAccount from "./service-account-credentials.json";

const credentialObject: object = serviceAccount;

const app = admin.initializeApp({
  credential: admin.credential.cert(credentialObject),
  
});

const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';

export const db = admin.firestore(app)

export default admin;