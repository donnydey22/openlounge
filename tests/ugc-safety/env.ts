// separate throwaway database so these tests can run alongside test:auth (which wipes ua_test)
process.env.TEST_DATABASE_URL ||= "postgresql://ua@127.0.0.1:55433/ugc_test";
