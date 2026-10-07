# Copy to ~/.openlounge-eas.env (outside the repo), fill in, then:  source ~/.openlounge-eas.env
# Never commit the real file or the .p8.

# Node >= 20.19.4 is required by Expo SDK 57 / React Native 0.86 (box system node is 20.19.2).
export PATH="$HOME/.local/node22/bin:$HOME/.local/bin:$PATH"

# 1. Expo account (https://expo.dev/settings/access-tokens). Replaces `eas login`.
export EXPO_TOKEN="..."

# 2. App Store Connect *Team* API key, role Admin (Users and Access > Integrations > Team Keys).
#    Replaces Apple ID + 2FA. The .p8 can only be downloaded once from Apple.
export EXPO_ASC_API_KEY_PATH="$HOME/.secrets/AuthKey_XXXXXXXXXX.p8"
export EXPO_ASC_KEY_ID="XXXXXXXXXX"
export EXPO_ASC_ISSUER_ID="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export EXPO_APPLE_TEAM_ID="XXXXXXXXXX"
export EXPO_APPLE_TEAM_TYPE="INDIVIDUAL"   # or COMPANY_OR_ORGANIZATION (or IN_HOUSE for Enterprise)
