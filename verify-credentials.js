
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const USER_TOKEN = process.env.USER_TOKEN?.trim();
const USER_PASSWORD = process.env.USER_PASSWORD?.trim();
const TARGET_GUILD_ID = process.env.TARGET_GUILD_ID?.trim();

console.log('Testing Discord credentials...\n');

async function verifyCredentials() {
  if (!USER_TOKEN || !USER_PASSWORD || !TARGET_GUILD_ID) {
    console.log('❌ Missing environment variables in .env file');
    return;
  }

  try {
    // Step 1: Test if token is valid by getting user info
    console.log('1. Testing USER_TOKEN validity...');
    const userResp = await axios.get('https://discord.com/api/v9/users/@me', {
      headers: { 'Authorization': USER_TOKEN }
    });
    console.log(`✅ Token is valid! User: ${userResp.data.username}#${userResp.data.discriminator}\n`);

    // Step 2: Try to trigger MFA
    console.log('2. Testing MFA authentication...');
    const patchResp = await axios.patch(
      `https://discord.com/api/v9/guilds/${TARGET_GUILD_ID}/vanity-url`,
      {},
      { headers: { 'Authorization': USER_TOKEN, 'Content-Type': 'application/json' } }
    );

    if (patchResp.data.code === 60003) {
      console.log('✅ MFA ticket received\n');
      
      // Step 3: Try to finish MFA with password
      console.log('3. Testing password authentication...');
      const finishResp = await axios.post(
        'https://discord.com/api/v9/mfa/finish',
        {
          ticket: patchResp.data.mfa.ticket,
          mfa_type: 'password',
          data: USER_PASSWORD
        },
        { headers: { 'Authorization': USER_TOKEN, 'Content-Type': 'application/json' } }
      );

      if (finishResp.data.token) {
        console.log('✅ SUCCESS! Password is correct and MFA token obtained!\n');
        console.log('Your credentials are working properly.');
      } else if (finishResp.data.code === 60008) {
        console.log('❌ FAILED: Password does NOT match this token!');
        console.log('Make sure USER_PASSWORD is for the same account as USER_TOKEN');
      } else {
        console.log('❌ Unexpected response:', finishResp.data);
      }
    }
    
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('❌ USER_TOKEN is invalid or expired');
    } else if (err.response?.data?.retry_after) {
      console.log(`⚠️ Rate limited: ${err.response.data.retry_after} seconds`);
      console.log('This confirms your IP/infrastructure is flagged by Discord');
    } else {
      console.log('❌ Error:', err.response?.data || err.message);
    }
  }
}

verifyCredentials();
