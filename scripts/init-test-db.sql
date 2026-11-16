-- Dedicated integration-test database; production application data is never reset by tests.
CREATE DATABASE tracker_test OWNER tracker;
